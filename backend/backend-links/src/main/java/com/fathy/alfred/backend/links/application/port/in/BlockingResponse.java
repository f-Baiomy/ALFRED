package com.fathy.alfred.backend.links.application.port.in;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * A relayed response read by one thread as it arrives: the connection thread only queues (the owner never sends more
 * than the credit given, so the queue stays small), the reading thread takes each piece, writes it on and gives one
 * credit back. Used to stream a body to the browser and to read a small JSON answer whole.
 */
public final class BlockingResponse implements ResponseSink {

    /** Chunks the owner may send before the reader has taken any. */
    public static final int INITIAL_CREDIT = 8;

    public sealed interface Piece permits Head, Chunk, End, Failure {
    }

    public record Head(int status, Map<String, String> headers) implements Piece {
    }

    public record Chunk(ByteBuffer data) implements Piece {
    }

    public record End() implements Piece {
    }

    public record Failure(String code, String message) implements Piece {
    }

    private final LinkedBlockingQueue<Piece> queue = new LinkedBlockingQueue<>();
    private RelayCall call;
    private int owedCredit;
    private boolean cancelled;

    /** The call this response belongs to; credit taken before it was known is given now. */
    public synchronized void attach(RelayCall relayCall) {
        this.call = relayCall;
        if (cancelled) {
            relayCall.cancel();
        } else if (owedCredit > 0) {
            relayCall.credit(owedCredit);
            owedCredit = 0;
        }
    }

    private synchronized void giveCredit() {
        if (call == null) {
            owedCredit++;
        } else {
            call.credit(1);
        }
    }

    @Override
    public void head(int status, Map<String, String> headers) {
        queue.add(new Head(status, headers));
    }

    @Override
    public void chunk(ByteBuffer data) {
        queue.add(new Chunk(data));
    }

    @Override
    public void end() {
        queue.add(new End());
    }

    @Override
    public void error(String code, String message) {
        queue.add(new Failure(code, message));
    }

    /** The next piece, or a TIMEOUT failure after {@code wait}. A taken chunk gives the owner room for one more. */
    public Piece next(Duration wait) throws InterruptedException {
        Piece p = queue.poll(wait.toMillis(), TimeUnit.MILLISECONDS);
        if (p == null) {
            cancel();
            return new Failure("TIMEOUT", "The other Alfred did not answer in " + wait.toSeconds() + " s");
        }
        if (p instanceof Chunk) {
            giveCredit();
        }
        return p;
    }

    public synchronized void cancel() {
        cancelled = true;
        if (call != null) {
            call.cancel();
        }
    }

    /** A whole answer (status, headers, body), for small JSON reads; at most {@code maxBytes} or TOO_LARGE. */
    public record Whole(int status, Map<String, String> headers, byte[] body) {

        public String text() {
            return new String(body, java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    public Whole readWhole(Duration wait, int maxBytes) throws InterruptedException {
        Head head = null;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (true) {
            Piece p = next(wait);
            if (p instanceof Failure f) {
                throw new LinkUnavailableException(f.code(), null, f.message());
            }
            if (p instanceof Head h) {
                head = h;
            } else if (p instanceof Chunk c) {
                if (out.size() + c.data().remaining() > maxBytes) {
                    cancel();
                    throw new LinkUnavailableException("TOO_LARGE", null, "The answer is larger than " + maxBytes + " bytes");
                }
                byte[] b = new byte[c.data().remaining()];
                c.data().get(b);
                out.write(b, 0, b.length);
            } else if (p instanceof End) {
                return new Whole(head == null ? 502 : head.status(), head == null ? Map.of() : head.headers(), out.toByteArray());
            }
        }
    }
}
