package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.domain.Mac;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Self;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * The waiting side of links: /ws/links/peer. A connecting Alfred is challenged first; only one that proves it holds a
 * link's secret gets a channel. Messages may arrive in parts (bodies are chunked at 128 KB) and are put together here.
 * Never through the tunnel: the bridge refuses the upgrade when a tunnel header is present.
 */
@Component
public class PeerSocketHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(PeerSocketHandler.class);

    /** What one connection may have buffered unsent before it is dropped (credit keeps it far below). */
    static final int SEND_BUFFER_BYTES = 64 * 1024 * 1024;

    private final PeerTransport transport;
    private final Map<String, State> states = new ConcurrentHashMap<>();

    private static final class State {
        final String nonce = Mac.random(16);
        final StringBuilder text = new StringBuilder();
        final ByteArrayOutputStream binary = new ByteArrayOutputStream();
        WebSocketSession session;
        PeerChannel channel;
        long openedAt = System.currentTimeMillis();
    }

    public PeerSocketHandler(PeerTransport transport) {
        this.transport = transport;
    }

    @Override
    public boolean supportsPartialMessages() {
        return true;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) throws IOException {
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 60_000, SEND_BUFFER_BYTES);
        State s = new State();
        s.session = session;
        states.put(raw.getId(), s);
        Self self = transport.inbound().self();
        ObjectNode challenge = Frames.frame("challenge");
        challenge.put("nonce", s.nonce);
        challenge.put("alfredId", self.alfredId());
        challenge.put("name", self.name());
        challenge.put("version", self.version());
        challenge.put("proto", Frames.PROTO);
        session.sendMessage(new TextMessage(Frames.text(challenge)));
        // a connection that never proves itself is dropped
        transport.scheduler().schedule(() -> {
            State st = states.get(raw.getId());
            if (st != null && st.channel == null && raw.isOpen()) {
                try {
                    raw.close(new CloseStatus(4008, "no proof"));
                } catch (IOException ignored) {
                    // gone
                }
            }
        }, 15, TimeUnit.SECONDS);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws IOException {
        State s = states.get(session.getId());
        if (s == null) {
            return;
        }
        s.text.append(message.getPayload());
        if (!message.isLast()) {
            return;
        }
        String whole = s.text.toString();
        s.text.setLength(0);
        if (s.channel != null) {
            s.channel.onText(whole);
            return;
        }
        handshake(session, s, whole);
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        State s = states.get(session.getId());
        if (s == null || s.channel == null) {
            return;
        }
        ByteBuffer b = message.getPayload();
        byte[] bytes = new byte[b.remaining()];
        b.get(bytes);
        s.binary.write(bytes, 0, bytes.length);
        if (message.isLast()) {
            ByteBuffer whole = ByteBuffer.wrap(s.binary.toByteArray());
            s.binary.reset();
            s.channel.onBinary(whole);
        }
    }

    private void handshake(WebSocketSession session, State s, String text) throws IOException {
        JsonNode f;
        try {
            f = Frames.parse(text);
        } catch (RuntimeException e) {
            session.close(new CloseStatus(4002, "bad frame"));
            return;
        }
        if (!"auth".equals(f.path("t").asText())) {
            return;
        }
        String peerId = f.path("alfredId").asText();
        Optional<Link> link = transport.inbound().waitingLinkFor(peerId);
        if (link.isEmpty()) {
            refuse(s, "This Alfred has no link with yours any more - link them again");
            return;
        }
        Link l = link.get();
        String expected = Mac.of(l.secret(), "auth|" + s.nonce + "|" + peerId);
        if (!Mac.same(expected, f.path("mac").asText())) {
            log.warn("Link {}: a connection claiming to be {} failed its proof", l.slug(), peerId);
            refuse(s, "The link's proof did not match - link them again");
            return;
        }
        Self self = transport.inbound().self();
        ObjectNode welcome = Frames.frame("welcome");
        welcome.put("mac", Mac.of(l.secret(), "welcome|" + f.path("nonce").asText()));
        welcome.put("name", self.name());
        welcome.put("version", self.version());
        welcome.put("time", System.currentTimeMillis());
        s.session.sendMessage(new TextMessage(Frames.text(welcome)));
        s.channel = transport.attach(l, new SpringWire(s.session), f.path("name").asText(null), f.path("version").asText(null));
    }

    private void refuse(State s, String why) throws IOException {
        ObjectNode r = Frames.frame("refused");
        r.put("why", why);
        s.session.sendMessage(new TextMessage(Frames.text(r)));
        s.session.close(new CloseStatus(4003, "refused"));
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        State s = states.get(session.getId());
        if (s != null && s.channel != null) {
            transport.closed(s.channel, exception.getMessage() == null ? exception.toString() : exception.getMessage());
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        State s = states.remove(session.getId());
        if (s != null && s.channel != null) {
            String why = status.getReason() == null || status.getReason().isBlank() ? "Closed (" + status.getCode() + ")" : status.getReason();
            transport.closed(s.channel, why);
        }
    }

    @Override
    protected void handlePongMessage(WebSocketSession session, org.springframework.web.socket.PongMessage message) {
        // the link keeps its own heartbeat
    }

    /** Spring's session behind the decorator: sends are serialized and buffered up to {@link #SEND_BUFFER_BYTES}. */
    static final class SpringWire implements Wire {

        private final WebSocketSession session;

        SpringWire(WebSocketSession session) {
            this.session = session;
        }

        @Override
        public void text(String json) {
            send(new TextMessage(json));
        }

        @Override
        public void binary(ByteBuffer data) {
            send(new BinaryMessage(data));
        }

        private void send(WebSocketMessage<?> m) {
            if (!session.isOpen()) {
                throw new IllegalStateException("closed");
            }
            try {
                session.sendMessage(m);
            } catch (IOException | RuntimeException e) {
                throw new IllegalStateException("send failed: " + e.getMessage());
            }
        }

        @Override
        public void close(int code, String why) {
            try {
                session.close(new CloseStatus(code, why));
            } catch (IOException ignored) {
                // gone
            }
        }
    }
}
