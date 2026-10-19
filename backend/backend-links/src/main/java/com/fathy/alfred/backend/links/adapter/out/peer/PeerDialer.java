package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.domain.Mac;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Self;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * The dialing side of one link: opens the WebSocket, answers the other Alfred's challenge, checks its welcome, and
 * dials again after a loss - 1, 2, 5, 10, 30 then every 60 seconds.
 */
final class PeerDialer {

    private static final Logger log = LoggerFactory.getLogger(PeerDialer.class);
    private static final long[] BACKOFF_SECONDS = {1, 2, 5, 10, 30, 60};

    private final Link link;
    private final PeerTransport transport;
    private volatile boolean stopped;
    private volatile int attempt;
    private volatile WebSocket socket;
    private volatile ScheduledFuture<?> next;
    private volatile boolean connecting;

    PeerDialer(Link link, PeerTransport transport) {
        this.link = link;
        this.transport = transport;
    }

    boolean sameAs(Link other) {
        return other.address() != null && other.address().equals(link.address()) && other.secret().equals(link.secret());
    }

    void start() {
        schedule(0);
    }

    /** Dial now instead of waiting out the pause (someone opened the page, the address was fixed). */
    void wake() {
        if (socket == null && !connecting) {
            ScheduledFuture<?> n = next;
            if (n != null) {
                n.cancel(false);
            }
            attempt = 0;
            schedule(0);
        }
    }

    void stop() {
        stopped = true;
        ScheduledFuture<?> n = next;
        if (n != null) {
            n.cancel(false);
        }
        WebSocket s = socket;
        if (s != null) {
            s.abort();
        }
    }

    /** The connection was lost after it worked: dial again soon. */
    void lost() {
        socket = null;
        if (!stopped) {
            attempt = 0;
            schedule(BACKOFF_SECONDS[0]);
        }
    }

    private void schedule(long seconds) {
        if (stopped) {
            return;
        }
        next = transport.scheduler().schedule(this::dial, seconds, TimeUnit.SECONDS);
    }

    private void retryLater(String why) {
        connecting = false;
        socket = null;
        transport.failed(link, why);
        if (stopped) {
            return;
        }
        long wait = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
        attempt++;
        schedule(wait);
    }

    static URI socketUri(String address) {
        String a = address.trim();
        if (a.endsWith("/")) {
            a = a.substring(0, a.length() - 1);
        }
        if (a.startsWith("https://")) {
            a = "wss://" + a.substring("https://".length());
        } else if (a.startsWith("http://")) {
            a = "ws://" + a.substring("http://".length());
        } else if (!a.startsWith("ws://") && !a.startsWith("wss://")) {
            a = "ws://" + a;
        }
        return URI.create(a + "/ws/links/peer");
    }

    private void dial() {
        if (stopped || connecting) {
            return;
        }
        connecting = true;
        Self self;
        try {
            self = transport.inbound().self();
        } catch (RuntimeException e) {
            retryLater("This Alfred is still starting");
            return;
        }
        Listener listener = new Listener(self);
        try {
            transport.http().newWebSocketBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .header("X-Alfred-Peer", self.alfredId())
                    .buildAsync(socketUri(link.address()), listener)
                    .whenComplete((ws, err) -> {
                        if (err != null) {
                            retryLater(describe(err));
                        } else {
                            socket = ws;
                        }
                    });
        } catch (RuntimeException e) {
            retryLater(describe(e));
        }
    }

    private String describe(Throwable err) {
        Throwable t = err;
        while (t.getCause() != null && t.getCause() != t) {
            t = t.getCause();
        }
        String m = t.getMessage();
        if (t instanceof java.net.ConnectException || (m != null && m.contains("Connection refused"))) {
            return link.name() + " (" + link.address() + ") is not answering";
        }
        if (t instanceof java.net.http.HttpTimeoutException) {
            return link.name() + " (" + link.address() + ") did not answer in time";
        }
        if (m != null && m.contains("404")) {
            return link.name() + " has no streams - update it";
        }
        return m == null ? t.getClass().getSimpleName() : m;
    }

    /** One connection attempt: the handshake first, then everything goes to the channel. */
    private final class Listener implements WebSocket.Listener {

        private final Self self;
        private final StringBuilder text = new StringBuilder();
        private final ByteArrayOutputStream binary = new ByteArrayOutputStream();
        private final String nonce = Mac.random(16);
        private PeerChannel channel;
        private JdkWire wire;
        private boolean challenged;

        Listener(Self self) {
            this.self = self;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            wire = new JdkWire(webSocket);
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            text.append(data);
            if (last) {
                String message = text.toString();
                text.setLength(0);
                try {
                    if (channel != null) {
                        channel.onText(message);
                    } else {
                        handshake(webSocket, message);
                    }
                } catch (RuntimeException e) {
                    log.warn("Link {}: {}", link.slug(), e.toString());
                }
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, ByteBuffer data, boolean last) {
            byte[] b = new byte[data.remaining()];
            data.get(b);
            binary.write(b, 0, b.length);
            if (last) {
                ByteBuffer whole = ByteBuffer.wrap(binary.toByteArray());
                binary.reset();
                if (channel != null) {
                    channel.onBinary(whole);
                }
            }
            webSocket.request(1);
            return null;
        }

        private void handshake(WebSocket webSocket, String message) {
            JsonNode f = Frames.parse(message);
            String t = f.path("t").asText();
            if ("challenge".equals(t) && !challenged) {
                challenged = true;
                String peerId = f.path("alfredId").asText();
                if (!peerId.equals(link.peerAlfredId())) {
                    wire.close(4003, "wrong Alfred");
                    retryLater("The Alfred at " + link.address() + " is not " + link.name() + " any more - link it again");
                    return;
                }
                ObjectNode auth = Frames.frame("auth");
                auth.put("alfredId", self.alfredId());
                auth.put("mac", Mac.of(link.secret(), "auth|" + f.path("nonce").asText() + "|" + self.alfredId()));
                auth.put("nonce", nonce);
                auth.put("name", self.name());
                auth.put("version", self.version());
                auth.put("proto", Frames.PROTO);
                wire.text(Frames.text(auth));
            } else if ("welcome".equals(t) && challenged) {
                if (!Mac.same(f.path("mac").asText(), Mac.of(link.secret(), "welcome|" + nonce))) {
                    wire.close(4001, "bad proof");
                    retryLater(link.name() + " could not prove it holds this link - link it again");
                    return;
                }
                attempt = 0;
                connecting = false;
                channel = transport.attach(link, wire, f.path("name").asText(null), f.path("version").asText(null));
            } else if ("refused".equals(t)) {
                String why = f.path("why").asText("refused");
                wire.close(1000, "refused");
                retryLater(why);
            }
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            gone(reason == null || reason.isBlank() ? "Closed (" + statusCode + ")" : reason);
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            gone(describe(error));
        }

        private void gone(String why) {
            if (channel != null) {
                transport.closed(channel, why);
            } else {
                retryLater(why);
            }
        }
    }

    /** java.net.http's WebSocket allows one send at a time: each waits for the previous one. */
    static final class JdkWire implements Wire {

        private final WebSocket ws;
        private CompletableFuture<?> last = CompletableFuture.completedFuture(null);

        JdkWire(WebSocket ws) {
            this.ws = ws;
        }

        @Override
        public synchronized void text(String json) {
            if (ws.isOutputClosed()) {
                throw new IllegalStateException("closed");
            }
            last = last.thenCompose(v -> ws.sendText(json, true));
            waitIfBehind();
        }

        @Override
        public synchronized void binary(ByteBuffer data) {
            if (ws.isOutputClosed()) {
                throw new IllegalStateException("closed");
            }
            last = last.thenCompose(v -> ws.sendBinary(data, true));
            waitIfBehind();
        }

        /** A binary send waits for the frame before it, so a writer never queues more than one chunk unsent. */
        private void waitIfBehind() {
            try {
                last.get(60, TimeUnit.SECONDS);
            } catch (Exception e) {
                ws.abort();
                throw new IllegalStateException("send failed: " + e.getMessage());
            }
        }

        @Override
        public void close(int code, String why) {
            try {
                ws.sendClose(code, why == null ? "" : why);
            } catch (RuntimeException ignored) {
                ws.abort();
            }
        }
    }
}
