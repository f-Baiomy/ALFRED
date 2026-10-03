package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.calls.application.port.in.FindReliveRunCallsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.FindInternalReliveRunCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyInternalCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ReliveRunCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.ReliveRunCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Collection;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Each Relive run keeps its calls in a session cycle of its own instead of in Live Calls or in
 * whatever cycle happens to be recording: the capture adapters route a call carrying
 * {@code relive.runId} here, and the Relive History tab opens the cycle in place. Created by the
 * first call of a run, or - for a run from before run cycles existed - by {@link #open}, which
 * then copies in every call of the run the call logs still hold.
 */
@Service
public class ReliveRunCyclesService implements ReliveRunCyclesUseCase {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;
    private final CapturedInternalCallsStorePort capturedInternalCallsStore;
    private final CycleSpacersStorePort spacersStore;
    private final FindReliveRunCallsUseCase outboundCalls;
    private final FindInternalReliveRunCallsUseCase inboundCalls;
    private final CopyCallsToCycleUseCase copyOutbound;
    private final CopyInternalCallsToCycleUseCase copyInbound;

    /** The call-log lookups are lazy: the call services fan every new call out to the capture
     *  adapters, which use this service - a constructor cycle otherwise. */
    public ReliveRunCyclesService(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore,
                                  CapturedInternalCallsStorePort capturedInternalCallsStore, CycleSpacersStorePort spacersStore,
                                  @Lazy FindReliveRunCallsUseCase outboundCalls, @Lazy FindInternalReliveRunCallsUseCase inboundCalls,
                                  CopyCallsToCycleUseCase copyOutbound, CopyInternalCallsToCycleUseCase copyInbound) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
        this.spacersStore = spacersStore;
        this.outboundCalls = outboundCalls;
        this.inboundCalls = inboundCalls;
        this.copyOutbound = copyOutbound;
        this.copyInbound = copyInbound;
    }

    @Override
    public ReliveRunCycle open(String runId, String name, String reliveCycleId) {
        ReliveRunCycle found = findOrCreate(runId, name, reliveCycleId);
        if (found.created()) {
            String id = found.cycle().id();
            copyOutbound.copyInto(id, outboundCalls.findByRunId(runId));
            copyInbound.copyInto(id, inboundCalls.findByRunId(runId));
        }
        return found;
    }

    @Override
    public String captureCycleId(String runId) {
        return findOrCreate(runId, null, null).cycle().id();
    }

    @Override
    public Optional<String> cycleIdOf(String runId) {
        return find(runId).map(SessionCycle::id);
    }

    @Override
    public synchronized int deleteForRuns(Collection<String> runIds) {
        if (runIds == null || runIds.isEmpty()) {
            return 0;
        }
        Set<String> wanted = Set.copyOf(runIds);
        int deleted = 0;
        for (SessionCycle cycle : metadataStore.findAll()) {
            if (cycle.reliveRunId() == null || !wanted.contains(cycle.reliveRunId())) {
                continue;
            }
            metadataStore.deleteById(cycle.id());
            capturedCallsStore.deleteAllForCycle(cycle.id());
            capturedInternalCallsStore.deleteAllForCycle(cycle.id());
            spacersStore.deleteAllForCycle(cycle.id());
            deleted++;
        }
        return deleted;
    }

    /** One lock for lookup and creation: a run's first outbound and inbound calls can arrive
     *  together, and two cycles for one run would split its calls. */
    private synchronized ReliveRunCycle findOrCreate(String runId, String name, String reliveCycleId) {
        Optional<SessionCycle> existing = find(runId);
        if (existing.isPresent()) {
            SessionCycle cycle = existing.get();
            String nextName = name == null || name.isBlank() ? cycle.name() : name;
            String nextCycleId = reliveCycleId == null || reliveCycleId.isBlank() ? cycle.reliveCycleId() : reliveCycleId;
            if (Objects.equals(nextName, cycle.name()) && Objects.equals(nextCycleId, cycle.reliveCycleId())) {
                return new ReliveRunCycle(cycle, false);
            }
            SessionCycle renamed = new SessionCycle(cycle.id(), nextName, cycle.createdAt(), cycle.assignedTo(), cycle.status(),
                    cycle.reliveRunId(), nextCycleId);
            return new ReliveRunCycle(metadataStore.save(renamed), false);
        }
        String shortId = runId.length() > 8 ? runId.substring(0, 8) : runId;
        SessionCycle created = new SessionCycle(UUID.randomUUID().toString(),
                name == null || name.isBlank() ? "Relive run " + shortId : name,
                Instant.now().toString(), null, SessionCycleStatus.PAUSED, runId,
                reliveCycleId == null || reliveCycleId.isBlank() ? null : reliveCycleId);
        return new ReliveRunCycle(metadataStore.save(created), true);
    }

    private Optional<SessionCycle> find(String runId) {
        if (runId == null || runId.isBlank()) {
            return Optional.empty();
        }
        return metadataStore.findAll().stream().filter(cycle -> runId.equals(cycle.reliveRunId())).findFirst();
    }
}
