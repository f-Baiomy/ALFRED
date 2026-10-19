package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseSink;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.domain.model.Link;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One authenticated link connection, either side (R3). Multiplexes reads both ways: requests this side sent wait in
 * {@code outgoing} for their head, chunks and end; requests the other side sent are answered by {@code serving}
 * writers, each sending no more chunks than the reader's credit. Events and signals are handled in arrival order on
 * one thread; reads run on the transport's pool, at most {@link #MAX_SERVING} at a time per link.
 */
final class PeerChannel {

    private static final Logger log = LoggerFactory.getLogger(PeerChannel.class);

    /** Reads answered at the same time for one link; more wait for a slot. */
    static final int MAX_SERVING = 16;
    /** How long a writer waits for the reader to make room before it gives up. */
    static final long CREDIT_WAIT_SECONDS = 120;

    private final Link link;
    private final Wire wire;
    private final PeerTransport transport;
    private final Map<String, ResponseSink> outgoing = new ConcurrentHashMap<>();
    private final Map<String, Serving> serving = new ConcurrentHashMap<>();
    private final Semaphore slots = new Semaphore(MAX_SERVING);
    private final ExecutorService ordered;
    private final AtomicInteger inFlight = new AtomicInteger();
    private volatile boolean closed;
    private volatile long lastHeard = System.currentTimeMillis();
    private volatile Long rttMs;
    private volatile Long offsetMs;
    private volatile long sentUpTo;
    private final Instant since = Instant.now();
    private final String peerName;
    private final String peerVersion;

    PeerChannel(Link link, Wire wire, PeerTransport transport, String peerName, String peerVersion) {
        this.link = link;
        this.wire = wire;
        this.transport = transport;
        this.peerName = peerName;
        this.peerVersion = peerVersion;
        this.ordered = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "link-events-" + link.slug());
            t.setDaemon(true);
            return t;
        });
    }

    Link link() {
        return link;
    }

    String peerName() {
        return peerName;
    }

    String peerVersion() {
        return peerVersion;
    }

    boolean closed() {
        return closed;
    }

    long lastHeard() {
        return lastHeard;
    }

    Long rttMs() {
        return rttMs;
    }

    Long offsetMs() {
        return offsetMs;
    }

    Instant since() {
        return since;
    }

    int inFlight() {
        return inFlight.get() + serving.size();
    }

    synchronized long sentUpTo() {
        return sentUpTo;
    }

    synchronized void sentUpTo(long seq) {
        sentUpTo = Math.max(sentUpTo, seq);
    }

    // ------------------------------------------------------------------------------------------------------- sending

    void send(JsonNode frame) {
        if (closed) {
            throw new LinkUnavailableException("OFFLINE", link.slug(), "The link to " + link.name() + " is offline");
        }
        wire.text(Frames.text(frame));
    }

    private void trySend(JsonNode frame) {
        try {
            if (!closed) {
                wire.text(Frames.text(frame));
            }
        } catch (RuntimeException e) {
            log.debug("Link {}: send failed: {}", link.slug(), e.getMessage());
        }
    }

    RelayCall request(RelayRequest r, ResponseSink sink) {
        if (closed) {
            throw new LinkUnavailableException("OFFLINE", link.slug(), "The link to " + link.name() + " is offline");
        }
        String id = UUID.randomUUID().toString();
        ResponseSink counted = new ResponseSink() {
            @Override
            public void head(int status, Map<String, String> headers) {
                sink.head(status, headers);
            }

            @Override
            public void chunk(ByteBuffer data) {
                sink.chunk(data);
            }

            @Override
            public void end() {
                inFlight.decrementAndGet();
                sink.end();
            }

            @Override
            public void error(String code, String message) {
                inFlight.decrementAndGet();
                sink.error(code, message);
            }
        };
        outgoing.put(id, counted);
        inFlight.incrementAndGet();
        ObjectNode f = Frames.frame("req");
        f.put("id", id);
        f.put("method", r.method());
        f.put("path", r.path());
        f.put("query", r.query());
        ObjectNode headers = f.putObject("headers");
        r.headers().forEach(headers::put);
        if (r.body() != null) {
            f.put("body", r.body());
        }
        ArrayNode hops = f.putArray("hops");
        r.hops().forEach(hops::add);
        f.put("credit", BlockingResponse.INITIAL_CREDIT);
        try {
            send(f);
        } catch (RuntimeException e) {
            if (outgoing.remove(id) != null) {
                inFlight.decrementAndGet();
            }
            throw e instanceof LinkUnavailableException l ? l : new LinkUnavailableException("OFFLINE", link.slug(), e.getMessage());
        }
        return new RelayCall() {
            @Override
            public void credit(int chunks) {
                if (outgoing.containsKey(id)) {
                    ObjectNode c = Frames.frame("credit");
                    c.put("id", id);
                    c.put("n", chunks);
                    trySend(c);
                }
            }

            @Override
            public void cancel() {
                if (outgoing.remove(id) != null) {
                    inFlight.decrementAndGet();
                    ObjectNode c = Frames.frame("cancel");
                    c.put("id", id);
                    trySend(c);
                }
            }
        };
    }

    void event(long seq, String kind, String data) {
        ObjectNode f = Frames.frame("event");
        f.put("seq", seq);
        f.put("kind", kind);
        f.put("data", data);
        send(f);
    }

    void signal(String channel, String data) {
        ObjectNode f = Frames.frame("signal");
        f.put("channel", channel);
        f.put("data", data);
        trySend(f);
    }

    void ping() {
        ObjectNode f = Frames.frame("ping");
        f.put("at", System.currentTimeMillis());
        if (rttMs != null) {
            f.put("rtt", rttMs);
        }
        if (offsetMs != null) {
            f.put("offset", offsetMs);
        }
        trySend(f);
    }

    // ----------------------------------------------------------------------------------------------------- receiving

    void onText(String text) {
        lastHeard = System.currentTimeMillis();
        JsonNode f;
        try {
            f = Frames.parse(text);
        } catch (RuntimeException e) {
            log.warn("Link {}: unreadable frame dropped", link.slug());
            return;
        }
        String id = f.path("id").asText(null);
        switch (f.path("t").asText()) {
            case "req" -> serve(f);
            case "credit" -> {
                Serving s = id == null ? null : serving.get(id);
                if (s != null) {
                    s.credit(Math.max(1, f.path("n").asInt(1)));
                }
            }
            case "cancel" -> {
                Serving s = id == null ? null : serving.get(id);
                if (s != null) {
                    s.cancelByReader();
                }
            }
            case "head" -> {
                ResponseSink sink = id == null ? null : outgoing.get(id);
                if (sink != null) {
                    Map<String, String> headers = new LinkedHashMap<>();
                    f.path("headers").fields().forEachRemaining(e -> headers.put(e.getKey(), e.getValue().asText()));
                    sink.head(f.path("status").asInt(502), headers);
                }
            }
            case "end" -> {
                ResponseSink sink = id == null ? null : outgoing.remove(id);
                if (sink != null) {
                    sink.end();
                }
            }
            case "err" -> {
                ResponseSink sink = id == null ? null : outgoing.remove(id);
                if (sink != null) {
                    sink.error(f.path("code").asText("FAILED"), f.path("message").asText(""));
                }
            }
            case "event" -> {
                long seq = f.path("seq").asLong();
                String kind = f.path("kind").asText();
                String data = f.path("data").asText("{}");
                ordered.execute(() -> {
                    try {
                        transport.event(this, seq, kind, data);
                        ObjectNode ack = Frames.frame("ack");
                        ack.put("seq", seq);
                        trySend(ack);
                    } catch (RuntimeException e) {
                        // not acked: sent again on the next connect
                        log.warn("Link {}: event {} ({}) failed: {}", link.slug(), seq, kind, e.toString());
                    }
                });
            }
            case "ack" -> transport.acked(this, f.path("seq").asLong());
            case "signal" -> {
                String channel = f.path("channel").asText();
                String data = f.path("data").asText("{}");
                ordered.execute(() -> {
                    try {
                        transport.signal(this, channel, data);
                    } catch (RuntimeException e) {
                        log.debug("Link {}: signal {} failed: {}", link.slug(), channel, e.toString());
                    }
                });
            }
            case "ping" -> {
                ObjectNode pong = Frames.frame("pong");
                pong.put("at", f.path("at").asLong());
                pong.put("now", System.currentTimeMillis());
                trySend(pong);
                if (f.has("rtt")) {
                    rttMs = f.path("rtt").asLong();
                }
                if (f.has("offset")) {
                    offsetMs = -f.path("offset").asLong();
                }
            }
            case "pong" -> {
                long now = System.currentTimeMillis();
                long at = f.path("at").asLong();
                long rtt = Math.max(0, now - at);
                rttMs = rtt;
                offsetMs = f.path("now").asLong() - (at + rtt / 2);
            }
            case "bye" -> transport.closed(this, f.path("why").asText("The other Alfred closed the link"));
            default -> {
                // a newer Alfred's frame: dropped (R4)
            }
        }
    }

    void onBinary(ByteBuffer data) {
        lastHeard = System.currentTimeMillis();
        Frames.Chunk c;
        try {
            c = Frames.readChunk(data);
        } catch (RuntimeException e) {
            log.warn("Link {}: unreadable chunk dropped", link.slug());
            return;
        }
        ResponseSink sink = outgoing.get(c.id());
        if (sink != null) {
            sink.chunk(c.data());
        }
    }

    private void serve(JsonNode f) {
        String id = f.path("id").asText();
        Map<String, String> headers = new LinkedHashMap<>();
        f.path("headers").fields().forEachRemaining(e -> headers.put(e.getKey(), e.getValue().asText()));
        List<String> hops = new ArrayList<>();
        f.path("hops").forEach(h -> hops.add(h.asText()));
        RelayRequest r = new RelayRequest(f.path("method").asText("GET"), f.path("path").asText("/"), f.path("query").asText(""), headers,
                f.hasNonNull("body") ? f.path("body").asText() : null, hops);
        Serving s = new Serving(id, Math.max(1, f.path("credit").asInt(BlockingResponse.INITIAL_CREDIT)));
        serving.put(id, s);
        transport.pool().execute(() -> {
            boolean slot = false;
            try {
                slot = slots.tryAcquire(30, TimeUnit.SECONDS);
                if (!slot) {
                    s.error("BUSY", link.name() + " is answering too many reads at once - try again");
                    return;
                }
                if (s.cancelled()) {
                    return;
                }
                transport.serve(this, r, s);
                s.finish();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                s.error("FAILED", "Interrupted");
            } catch (RuntimeException e) {
                log.warn("Link {}: serving {} {} failed: {}", link.slug(), r.method(), r.path(), e.toString());
                s.error("FAILED", e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                if (slot) {
                    slots.release();
                }
                serving.remove(id);
            }
        });
    }

    /** The connection is gone: every read waiting on it learns OFFLINE, every answer in progress stops. */
    void close(String why) {
        if (closed) {
            return;
        }
        closed = true;
        for (Iterator<Map.Entry<String, ResponseSink>> it = outgoing.entrySet().iterator(); it.hasNext(); ) {
            ResponseSink sink = it.next().getValue();
            it.remove();
            try {
                sink.error("OFFLINE", link.name() + " went offline: " + why);
            } catch (RuntimeException ignored) {
                // the reader is gone too
            }
        }
        serving.values().forEach(Serving::cancelByReader);
        ordered.shutdown();
    }

    /** Answers one read: buffers small writes into chunks, sends a chunk only when the reader has room. */
    final class Serving implements ResponseWriter {

        private final String id;
        private final Semaphore credit;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        private volatile boolean cancelled;
        private boolean headSent;
        private boolean done;

        Serving(String id, int initialCredit) {
            this.id = id;
            this.credit = new Semaphore(initialCredit);
        }

        void credit(int n) {
            credit.release(n);
        }

        void cancelByReader() {
            cancelled = true;
            credit.release(10_000);
        }

        @Override
        public synchronized void head(int status, Map<String, String> headers) throws IOException {
            if (done || headSent) {
                return;
            }
            check();
            ObjectNode f = Frames.frame("head");
            f.put("id", id);
            f.put("status", status);
            ObjectNode h = f.putObject("headers");
            headers.forEach((k, v) -> {
                if (k != null && v != null) {
                    h.put(k, v);
                }
            });
            sendOrFail(f);
            headSent = true;
        }

        @Override
        public synchronized void write(byte[] data, int offset, int length) throws IOException {
            if (done) {
                throw new IOException("The answer is already complete");
            }
            if (!headSent) {
                head(200, Map.of());
            }
            int pos = offset;
            int end = offset + length;
            while (pos < end) {
                int room = Frames.CHUNK - buffer.size();
                int n = Math.min(room, end - pos);
                buffer.write(data, pos, n);
                pos += n;
                if (buffer.size() >= Frames.CHUNK) {
                    sendBuffer();
                }
            }
        }

        private void sendBuffer() throws IOException {
            if (buffer.size() == 0) {
                return;
            }
            check();
            try {
                if (!credit.tryAcquire(CREDIT_WAIT_SECONDS, TimeUnit.SECONDS)) {
                    cancelled = true;
                    throw new IOException("The reader stopped reading");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted");
            }
            check();
            byte[] b = buffer.toByteArray();
            buffer.reset();
            try {
                wire.binary(Frames.chunk(id, b, 0, b.length));
            } catch (RuntimeException e) {
                cancelled = true;
                throw new IOException("The link dropped: " + e.getMessage());
            }
        }

        private void check() throws IOException {
            if (cancelled || closed) {
                throw new IOException("The reader cancelled or the link dropped");
            }
        }

        private void sendOrFail(JsonNode f) throws IOException {
            try {
                wire.text(Frames.text(f));
            } catch (RuntimeException e) {
                cancelled = true;
                throw new IOException("The link dropped: " + e.getMessage());
            }
        }

        @Override
        public synchronized void end() throws IOException {
            if (done) {
                return;
            }
            if (!headSent) {
                head(200, Map.of());
            }
            sendBuffer();
            done = true;
            ObjectNode f = Frames.frame("end");
            f.put("id", id);
            sendOrFail(f);
        }

        @Override
        public synchronized void error(String code, String message) {
            if (done) {
                return;
            }
            done = true;
            buffer.reset();
            ObjectNode f = Frames.frame("err");
            f.put("id", id);
            f.put("code", code == null ? "FAILED" : code);
            f.put("message", message == null ? "" : message);
            trySend(f);
        }

        /** A server that returned without ending: end it (or report the drop). */
        synchronized void finish() {
            if (done) {
                return;
            }
            if (cancelled || closed) {
                done = true;
                return;
            }
            try {
                end();
            } catch (IOException e) {
                error("FAILED", e.getMessage());
            }
        }

        @Override
        public boolean cancelled() {
            return cancelled || closed;
        }
    }
}
