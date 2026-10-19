package com.fathy.alfred.backend.links.adapter.out.peer;

import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.PeerInboundUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayCall;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseSink;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Self;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.CRC32;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The relay between two linked Alfreds (R3): a body streams in 128 KB chunks under the reader's credit, so neither side
 * holds more than a few chunks however large it is; a drop mid-body tells the reader OFFLINE; one stalled read never
 * holds up another on the same link.
 */
class PeerChannelRelayTest {

    /** What the owner answers: path -> how. */
    private interface Answer {
        void serve(RelayRequest r, ResponseWriter w) throws IOException;
    }

    private final AtomicReference<Answer> answer = new AtomicReference<>();
    private PeerTransport ownerTransport;
    private PeerTransport readerTransport;
    private PeerChannel owner;
    private PeerChannel reader;

    private static Link link(String slug) {
        return new Link("L-" + slug, slug, slug, "peer-" + slug, slug, "http://" + slug, true, "s3cret", Instant.now(), null, "e2e", null);
    }

    @SuppressWarnings("unchecked")
    private PeerTransport transport() {
        PeerInboundUseCase inbound = new PeerInboundUseCase() {
            @Override
            public Self self() {
                return null;
            }

            @Override
            public Optional<Link> waitingLinkFor(String peerAlfredId) {
                return Optional.empty();
            }

            @Override
            public void online(Link link, String peerName, String peerVersion) {
            }

            @Override
            public void offline(String linkId, String why) {
            }

            @Override
            public void event(Link link, long seq, String kind, String data) {
            }

            @Override
            public void signal(Link link, String channel, String data) {
            }

            @Override
            public void serve(Link link, RelayRequest request, ResponseWriter writer) {
                try {
                    answer.get().serve(request, writer);
                } catch (IOException e) {
                    throw new IllegalStateException(e);
                }
            }
        };
        ObjectProvider<PeerInboundUseCase> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(inbound);
        return new PeerTransport(provider, mock(LinksStorePort.class));
    }

    /** Two channels joined by an in-memory socket: what one side sends, the other receives on the sender's thread. */
    @BeforeEach
    void join() {
        ownerTransport = transport();
        readerTransport = transport();
        AtomicReference<PeerChannel> o = new AtomicReference<>();
        AtomicReference<PeerChannel> r = new AtomicReference<>();
        owner = new PeerChannel(link("pc-1"), wireTo(r), ownerTransport, "PC-1", "e2e");
        reader = new PeerChannel(link("stg-83"), wireTo(o), readerTransport, "STG 83", "e2e");
        o.set(owner);
        r.set(reader);
    }

    private static Wire wireTo(AtomicReference<PeerChannel> other) {
        return new Wire() {
            @Override
            public synchronized void text(String json) {
                other.get().onText(json);
            }

            @Override
            public synchronized void binary(ByteBuffer data) {
                other.get().onBinary(data);
            }

            @Override
            public void close(int code, String why) {
            }
        };
    }

    @AfterEach
    void stop() {
        owner.close("test over");
        reader.close("test over");
        ownerTransport.stop();
        readerTransport.stop();
    }

    private static byte[] block(int i) {
        byte[] b = new byte[64 * 1024];
        for (int k = 0; k < b.length; k++) {
            b[k] = (byte) (i * 31 + k);
        }
        return b;
    }

    private static RelayRequest get(String path) {
        return new RelayRequest("GET", path, "", Map.of(), null, List.of());
    }

    /** Counts chunks handed to the reader's queue, so the test can see how many wait there at most. */
    private static final class Counted implements ResponseSink {
        final BlockingResponse inner = new BlockingResponse();
        final AtomicInteger received = new AtomicInteger();

        @Override
        public void head(int status, Map<String, String> headers) {
            inner.head(status, headers);
        }

        @Override
        public void chunk(ByteBuffer data) {
            received.incrementAndGet();
            inner.chunk(data);
        }

        @Override
        public void end() {
            inner.end();
        }

        @Override
        public void error(String code, String message) {
            inner.error(code, message);
        }
    }

    private Counted ask(String path) {
        Counted sink = new Counted();
        RelayCall call = reader.request(get(path), sink);
        sink.inner.attach(call);
        return sink;
    }

    @Test
    void aBigBodyArrivesWholeWhileTheSlowReaderNeverHoldsMoreThanItsCredit() throws Exception {
        int blocks = 3200; // 200 MB
        CRC32 sent = new CRC32();
        for (int i = 0; i < blocks; i++) {
            sent.update(block(i));
        }
        answer.set((r, w) -> {
            w.head(200, Map.of("Content-Type", "application/octet-stream"));
            for (int i = 0; i < blocks; i++) {
                w.write(block(i));
            }
            w.end();
        });
        Counted sink = ask("/big");
        CRC32 got = new CRC32();
        long bytes = 0;
        int taken = 0;
        int mostWaiting = 0;
        int status = 0;
        while (true) {
            BlockingResponse.Piece p = sink.inner.next(Duration.ofSeconds(30));
            if (p instanceof BlockingResponse.Head h) {
                status = h.status();
            } else if (p instanceof BlockingResponse.Chunk c) {
                mostWaiting = Math.max(mostWaiting, sink.received.get() - taken);
                taken++;
                byte[] b = new byte[c.data().remaining()];
                c.data().get(b);
                got.update(b);
                bytes += b.length;
                if (taken % 64 == 0) {
                    Thread.sleep(5); // a slow browser
                }
            } else if (p instanceof BlockingResponse.End) {
                break;
            } else {
                throw new AssertionError("relay failed: " + p);
            }
        }
        assertThat(status).isEqualTo(200);
        assertThat(bytes).isEqualTo(blocks * 64L * 1024);
        assertThat(got.getValue()).isEqualTo(sent.getValue());
        assertThat(taken).isEqualTo((int) (bytes / Frames.CHUNK));
        // the owner sends only what the credit allows: the reader's queue never holds more than the credit (+1 in flight)
        assertThat(mostWaiting).isLessThanOrEqualTo(BlockingResponse.INITIAL_CREDIT + 1);
        assertThat(reader.inFlight()).isZero();
    }

    @Test
    void aDropMidBodyTellsTheReaderOfflineAndStopsTheWriter() throws Exception {
        CountDownLatch writerStopped = new CountDownLatch(1);
        answer.set((r, w) -> {
            try {
                for (int i = 0; ; i++) {
                    w.write(block(i));
                }
            } catch (IOException e) {
                writerStopped.countDown();
                throw e;
            }
        });
        Counted sink = ask("/endless");
        int chunks = 0;
        while (chunks < 3) {
            if (sink.inner.next(Duration.ofSeconds(10)) instanceof BlockingResponse.Chunk) {
                chunks++;
            }
        }
        reader.close("the cable");
        owner.close("the cable");
        BlockingResponse.Piece p;
        do {
            p = sink.inner.next(Duration.ofSeconds(10));
        } while (p instanceof BlockingResponse.Chunk);
        assertThat(p).isInstanceOfSatisfying(BlockingResponse.Failure.class, f -> assertThat(f.code()).isEqualTo("OFFLINE"));
        assertThat(writerStopped.await(10, TimeUnit.SECONDS)).isTrue();
    }

    @Test
    void aStalledReadNeverHoldsUpASmallOneOnTheSameLink() throws Exception {
        answer.set((r, w) -> {
            if (r.path().equals("/small")) {
                w.head(200, Map.of("Content-Type", "application/json"));
                w.write("{\"ok\":true}".getBytes());
                w.end();
                return;
            }
            for (int i = 0; i < 1000; i++) {
                w.write(block(i)); // blocks once the credit is used up: nobody reads this one
            }
            w.end();
        });
        Counted stalled = ask("/big");
        Counted small = ask("/small");
        BlockingResponse.Whole whole = small.inner.readWhole(Duration.ofSeconds(10), 1024);
        assertThat(whole.status()).isEqualTo(200);
        assertThat(whole.text()).isEqualTo("{\"ok\":true}");
        assertThat(stalled.received.get()).isLessThanOrEqualTo(BlockingResponse.INITIAL_CREDIT);
        stalled.inner.cancel();
    }
}
