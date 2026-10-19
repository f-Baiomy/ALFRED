package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.links.application.port.in.SignalsUseCase;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Hears this Alfred's own "something changed" sockets the way a page does (from 127.0.0.1), so a stream's readers hear
 * them too - every slice keeps its own socket and none of them needs to know about links. Only the channels that can
 * concern streamed things are heard; reconnects after a drop.
 */
@Component
public class LocalSignalTap {

    private static final Logger log = LoggerFactory.getLogger(LocalSignalTap.class);

    /** Socket path to the channel name signals carry over a link. */
    static final Map<String, String> CHANNELS = Map.of(
            "/ws/session-cycles", "session-cycles",
            "/ws/board", "board",
            "/ws/comments", "comments",
            "/ws/db-capture", "db-capture");

    private final Loopback loopback;
    private final ObjectProvider<SignalsUseCase> signals;
    private final StreamScope scope;
    private final StreamNames names;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "link-signal-tap");
        t.setDaemon(true);
        return t;
    });
    private final Map<String, WebSocket> open = new ConcurrentHashMap<>();
    private volatile boolean stopped;

    public LocalSignalTap(Loopback loopback, ObjectProvider<SignalsUseCase> signals, StreamScope scope, StreamNames names) {
        this.loopback = loopback;
        this.signals = signals;
        this.scope = scope;
        this.names = names;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        CHANNELS.forEach((path, channel) -> connect(path, channel, 0));
    }

    @PreDestroy
    void stop() {
        stopped = true;
        open.values().forEach(WebSocket::abort);
        timer.shutdownNow();
    }

    private void connect(String path, String channel, int attempt) {
        if (stopped) {
            return;
        }
        StringBuilder text = new StringBuilder();
        WebSocket.Listener listener = new WebSocket.Listener() {
            @Override
            public void onOpen(WebSocket webSocket) {
                webSocket.request(1);
            }

            @Override
            public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                text.append(data);
                if (last) {
                    String message = text.toString();
                    text.setLength(0);
                    heard(channel, message);
                }
                webSocket.request(1);
                return null;
            }

            @Override
            public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
                open.remove(path);
                later(path, channel, 0);
                return null;
            }

            @Override
            public void onError(WebSocket webSocket, Throwable error) {
                open.remove(path);
                later(path, channel, attempt + 1);
            }
        };
        String base = "ws://127.0.0.1:" + loopback.port();
        http.newWebSocketBuilder().buildAsync(URI.create(base + path), listener).whenComplete((ws, err) -> {
            if (err != null) {
                log.debug("Signal tap {}: {}", path, err.toString());
                later(path, channel, attempt + 1);
            } else {
                open.put(path, ws);
            }
        });
    }

    private void later(String path, String channel, int attempt) {
        if (stopped) {
            return;
        }
        long wait = List.of(1L, 2L, 5L, 10L, 30L).get(Math.min(attempt, 4));
        timer.schedule(() -> connect(path, channel, attempt), wait, TimeUnit.SECONDS);
    }

    void heard(String channel, String message) {
        if (("session-cycles".equals(channel) && message.contains("session-cycles-changed")) || ("board".equals(channel) && message.contains("\"board-changed\"") && !message.contains("\"cardId\""))) {
            names.changed();
        }
        SignalsUseCase s = signals.getIfAvailable();
        if (s != null) {
            try {
                s.local(channel, message);
            } catch (RuntimeException e) {
                log.debug("Signal {} not passed on: {}", channel, e.toString());
            }
        }
    }
}
