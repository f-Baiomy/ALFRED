package com.fathy.alfred.backend.links.application.port.in;

import java.time.Duration;

/**
 * Reads another Alfred's data over a link (R1-R3). Nothing read is stored here (D20): the body goes straight on, to the
 * browser or to the caller, chunk by chunk.
 */
public interface RelayUseCase {

    /** Sends the read; pieces arrive on {@code sink}. Throws {@link LinkUnavailableException} when it cannot be sent. */
    RelayCall open(String slug, RelayRequest request, ResponseSink sink);

    /** A small read, whole: for the backend's own use (a remote cycle's calls for judging, a name). */
    BlockingResponse.Whole fetch(String slug, RelayRequest request, Duration wait, int maxBytes);

    /** True when {@code slug} names a link this Alfred has (removed or not), so a suffix is a ref and not text. */
    boolean knows(String slug);

    boolean online(String slug);
}
