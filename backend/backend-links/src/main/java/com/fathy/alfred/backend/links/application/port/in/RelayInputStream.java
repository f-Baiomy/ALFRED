package com.fathy.alfred.backend.links.application.port.in;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;

/**
 * A relayed body read as a stream, after its head: each chunk taken gives the owner room for one more, so whatever reads
 * this (a JSON rewriter, a copy to the browser) sets the pace. A link that drops mid-body is an IOException naming
 * OFFLINE - never a silently shorter body.
 */
public final class RelayInputStream extends InputStream {

    private final BlockingResponse response;
    private final Duration wait;
    private ByteBuffer current;
    private boolean ended;
    private int status = -1;
    private Map<String, String> headers = Map.of();

    public RelayInputStream(BlockingResponse response, Duration wait) {
        this.response = response;
        this.wait = wait;
    }

    /** Waits for the head; throws {@link LinkUnavailableException} when the read failed before any answer. */
    public int awaitHead() throws InterruptedException {
        while (status < 0) {
            BlockingResponse.Piece p = response.next(wait);
            if (p instanceof BlockingResponse.Head h) {
                status = h.status();
                headers = h.headers();
            } else if (p instanceof BlockingResponse.Failure f) {
                throw new LinkUnavailableException(f.code(), null, f.message());
            } else if (p instanceof BlockingResponse.End) {
                status = 502;
                ended = true;
            } else if (p instanceof BlockingResponse.Chunk c) {
                status = 200;
                current = c.data();
            }
        }
        return status;
    }

    public Map<String, String> headers() {
        return headers;
    }

    private boolean fill() throws IOException {
        while (!ended && (current == null || !current.hasRemaining())) {
            BlockingResponse.Piece p;
            try {
                p = response.next(wait);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                response.cancel();
                throw new IOException("Interrupted");
            }
            if (p instanceof BlockingResponse.Chunk c) {
                current = c.data();
            } else if (p instanceof BlockingResponse.End) {
                ended = true;
            } else if (p instanceof BlockingResponse.Failure f) {
                ended = true;
                throw new IOException(f.code() + ": " + f.message());
            }
        }
        return current != null && current.hasRemaining();
    }

    @Override
    public int read() throws IOException {
        if (!fill()) {
            return -1;
        }
        return current.get() & 0xff;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        if (len == 0) {
            return 0;
        }
        if (!fill()) {
            return -1;
        }
        int n = Math.min(len, current.remaining());
        current.get(b, off, n);
        return n;
    }

    @Override
    public void close() {
        if (!ended) {
            response.cancel();
            ended = true;
        }
    }
}
