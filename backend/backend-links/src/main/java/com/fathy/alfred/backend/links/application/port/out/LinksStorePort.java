package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.EnvAssignment;
import com.fathy.alfred.backend.links.domain.model.EnvCycle;
import com.fathy.alfred.backend.links.domain.model.EnvDef;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.ReadEntry;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Stream;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/** links.db: configuration and requests only - never a streamed call, body or board text (D20). */
public interface LinksStorePort {

    /** A durable event waiting for the other Alfred's ack (D26). */
    record OutboxEvent(long seq, String linkId, String kind, String data, Instant at) {
    }

    // ------------------------------------------------------------------------------------------------------- self
    Optional<String> setting(String key);

    void setting(String key, String value);

    // ------------------------------------------------------------------------------------------------------ links
    List<Link> links(boolean includeRemoved);

    Optional<Link> link(String id);

    Optional<Link> linkBySlug(String slug);

    Optional<Link> linkByPeer(String peerAlfredId);

    void saveLink(Link link);

    // ---------------------------------------------------------------------------------------------------- streams
    List<Stream> streams();

    Optional<Stream> stream(String id);

    void saveStream(Stream stream);

    void deleteStream(String id);

    // --------------------------------------------------------------------------------------------------- requests
    Optional<LinkRequest> request(String id);

    void saveRequest(LinkRequest request);

    /** Saves {@code next} only if the stored request is still in {@code expected} state: the first answer wins (D11). */
    boolean answerRequest(LinkRequest next, RequestState expected);

    List<LinkRequest> requests(Boolean incoming, RequestState state, String linkId, int limit);

    int countRequests(boolean incoming, RequestState state);

    /** A middle Alfred passed a reader's request on (D8): which of its links the answer goes back to. */
    void relayFor(String requestId, String forLinkId);

    Optional<String> relayedFor(String requestId);

    // ----------------------------------------------------------------------------------------- events (D26 cursor)
    long enqueue(String linkId, String kind, String data, Instant at);

    List<OutboxEvent> outbox(String linkId);

    void acked(String linkId, long seq);

    long lastReceived(String linkId);

    /** Records {@code seq} as handled; false when it was handled before (a repeat after a reconnect). */
    boolean received(String linkId, long seq);

    void clearEvents(String linkId);

    // -------------------------------------------------------------------------------------------------- read log
    void countRead(String linkId, String family, String target, String via, Instant at);

    List<ReadEntry> reads(String linkId, String sinceDay);

    void pruneReads(String beforeDay);

    // ---------------------------------------------------------------------------------------------- environments
    List<EnvDef> envDefs(String boardId);

    List<EnvDef> envDefsOfLink(String linkId);

    void saveEnvDefs(String boardId, List<EnvDef> defs);

    List<EnvAssignment> assignments(String hostLinkId);

    List<EnvAssignment> allAssignments();

    void saveAssignments(String hostLinkId, String boardId, List<EnvAssignment> assignments);

    List<EnvMark> envMarks(String hostLinkId, String boardId);

    Optional<EnvMark> envMark(String hostLinkId, String boardId, String fileName, String itemKey);

    void saveEnvMark(EnvMark mark);

    void deleteEnvMark(String hostLinkId, String boardId, String fileName, String itemKey);

    List<EnvStep> envSteps(String hostLinkId, String boardId);

    void saveEnvStep(EnvStep step);

    void deleteEnvStep(String hostLinkId, String boardId, String stepKey);

    List<EnvRetest> envRetests(String hostLinkId, String boardId);

    void saveEnvRetest(EnvRetest retest);

    /** Test cycles of a board's environments: {@code hostLinkId} null on the host, the host's link on an environment Alfred. */
    List<EnvCycle> envCycles(String hostLinkId, String boardId);

    List<EnvCycle> envCyclesOf(String cycleRef);

    void saveEnvCycle(EnvCycle cycle);

    void deleteEnvCycle(String hostLinkId, String boardId, String cycleRef);
}
