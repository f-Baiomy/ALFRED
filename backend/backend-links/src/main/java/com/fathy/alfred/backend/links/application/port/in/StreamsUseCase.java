package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;

import java.util.List;
import java.util.Optional;

/** Streams this Alfred offers others and the ones it was given (D5-D8, D12, D17, D22). */
public interface StreamsUseCase {

    record StreamIn(String linkId, StreamKind kind, String target, String targetName, String project, StreamMode mode, boolean autoAccept,
                    boolean passOn, StreamMode passMode, boolean unmasked, String env, String forBoard) {
    }

    record StreamPatch(StreamMode mode, Boolean autoAccept, Boolean passOn, StreamMode passMode, Boolean unmasked) {
    }

    /** Starts a stream, or changes the one already streaming the same thing to the same link. */
    Stream start(StreamIn in);

    Stream update(String id, StreamPatch patch);

    /** Ends a stream; the reader keeps a "stream ended" line where it was shown (D22). */
    void stop(String id);

    /** The reader drops its copy of a stream the owner ended (it stays listed as "stream ended" until then). */
    void forget(String id);

    Optional<Stream> get(String id);

    /** Every stream, optionally only this Alfred's own ({@code mine}) or only those given to it, of one link or target. */
    List<Stream> streams(Boolean mine, String linkId, StreamKind kind, String target, boolean includeEnded);

    /** The active streams this Alfred offers one link. */
    List<Stream> offeredTo(String linkId);

    /** The owner renamed a streamed cycle or board: readers see the new name. */
    void renamed(StreamKind kind, String target, String name, String project);
}
