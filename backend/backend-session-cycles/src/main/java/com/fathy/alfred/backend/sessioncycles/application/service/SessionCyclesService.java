package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.UpdateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleUpdate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@Service
public class SessionCyclesService implements
        CreateSessionCycleUseCase,
        ListSessionCyclesUseCase,
        GetSessionCycleUseCase,
        UpdateSessionCycleUseCase,
        StartRecordingUseCase,
        PauseRecordingUseCase,
        DeleteSessionCycleUseCase,
        ListCapturedCallsUseCase,
        GetCapturedCallDetailUseCase,
        RemoveCapturedCallUseCase,
        RemoveCapturedCallsUseCase,
        CopyCallsToCycleUseCase {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedCallsStorePort capturedCallsStore;
    private final SessionCycleNotificationPort notificationPort;

    /** Same property + same clamp CallsService applies to GET /calls, reused here so a page of captured calls can't be forced unbounded either. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

    /** See CallListSupport.apply's paginationEnabled param. */
    @Value("${alfred.calls.pagination-enabled:true}")
    private boolean paginationEnabled;

    public SessionCyclesService(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore, SessionCycleNotificationPort notificationPort) {
        this.metadataStore = metadataStore;
        this.capturedCallsStore = capturedCallsStore;
        this.notificationPort = notificationPort;
    }

    @Override
    public SessionCycle create(NewSessionCycle newSessionCycle) {
        SessionCycle cycle = new SessionCycle(
                UUID.randomUUID().toString(),
                newSessionCycle.name(),
                Instant.now().toString(),
                newSessionCycle.assignedTo(),
                SessionCycleStatus.PAUSED
        );
        SessionCycle saved = metadataStore.save(cycle);
        notificationPort.notifySessionCyclesChanged();
        return saved;
    }

    @Override
    public List<SessionCycle> listAll() {
        return metadataStore.findAll();
    }

    @Override
    public Optional<SessionCycle> getById(String id) {
        return metadataStore.findById(id);
    }

    @Override
    public Optional<SessionCycle> update(String id, SessionCycleUpdate update) {
        return metadataStore.findById(id).map(existing -> {
            SessionCycle updated = new SessionCycle(
                    existing.id(),
                    update.name() != null ? update.name() : existing.name(),
                    existing.createdAt(),
                    // Unlike name, assignedTo is always applied exactly as given rather than
                    // "null means leave alone" - every caller (the edit dialog, bulk reassign)
                    // always sends the assignedTo it wants, including null to explicitly clear
                    // it back to unassigned, so treating null as "unchanged" here silently
                    // dropped that clear.
                    update.assignedTo(),
                    existing.status()
            );
            SessionCycle saved = metadataStore.save(updated);
            notificationPort.notifySessionCyclesChanged();
            return saved;
        });
    }

    @Override
    public Optional<SessionCycle> startRecording(String id) {
        return setStatus(id, SessionCycleStatus.RECORDING);
    }

    @Override
    public Optional<SessionCycle> pauseRecording(String id) {
        return setStatus(id, SessionCycleStatus.PAUSED);
    }

    private Optional<SessionCycle> setStatus(String id, SessionCycleStatus status) {
        return metadataStore.findById(id).map(existing -> {
            if (existing.status() == status) {
                return existing;
            }
            SessionCycle updated = new SessionCycle(
                    existing.id(), existing.name(), existing.createdAt(), existing.assignedTo(), status
            );
            SessionCycle saved = metadataStore.save(updated);
            notificationPort.notifySessionCyclesChanged();
            return saved;
        });
    }

    @Override
    public DeleteOutcome delete(String id) {
        Optional<SessionCycle> existing = metadataStore.findById(id);
        if (existing.isEmpty()) {
            return DeleteOutcome.NOT_FOUND;
        }
        if (existing.get().status() == SessionCycleStatus.RECORDING) {
            return DeleteOutcome.BLOCKED_RECORDING;
        }
        metadataStore.deleteById(id);
        capturedCallsStore.deleteAllForCycle(id);
        notificationPort.notifySessionCyclesChanged();
        return DeleteOutcome.DELETED;
    }

    /** Filters/sorts/paginates via whichever CapturedCallsStorePort adapter is active (CallListSupport for the file adapter, SQL for the SQLite adapter) - same delegation shape as CallsService.getCalls. */
    @Override
    public Optional<CapturedCallsPage> listCalls(String cycleId, CallsQuery query) {
        return metadataStore.findById(cycleId).map(cycle -> {
            int clampedOffset = Math.max(0, query.offset());
            // Disabled pagination means "everything up to maxLimit in one response" - see
            // CallsService.getCalls for why query.limit() must not be used here in that case.
            int clampedLimit = paginationEnabled ? Math.max(1, Math.min(query.limit(), maxLimit)) : maxLimit;

            CallListSupport.Page<CapturedCall> page = capturedCallsStore.query(
                    cycleId, query.search(), query.supplier(), query.sort(), clampedOffset, clampedLimit, paginationEnabled);
            List<CapturedCallSummary> summaries = page.items().stream().map(CapturedCallSummary::of).toList();
            return new CapturedCallsPage(summaries, page.total());
        });
    }

    /**
     * Scoped to this cycle's own captured-calls file, not the main log - a captured call's body
     * can outlive its presence in RECENT_CALLS.log (a capped ring buffer), since this file has no
     * such cap. {@code callId} here is the underlying CallRecord's id (CapturedCallSummary.call.id
     * in the list response), not the CapturedCall wrapper's own id - matching what GET /calls'
     * list uses, so the frontend's expand-to-fetch flow keys on one consistent "call id" concept
     * whether it's looking at the dashboard or a cycle detail page. removeCall (below) is the one
     * place the wrapper id is still the right key, since removal is scoped to this cycle's file.
     */
    @Override
    public Optional<CallDetail> getDetail(String cycleId, String callId) {
        if (metadataStore.findById(cycleId).isEmpty()) {
            return Optional.empty();
        }
        return capturedCallsStore.findByCallId(cycleId, callId).map(captured -> CallDetail.of(captured.call()));
    }

    @Override
    public boolean removeCall(String cycleId, String callId) {
        return capturedCallsStore.removeById(cycleId, callId);
    }

    @Override
    public Optional<RemoveCallsResult> removeCalls(String cycleId, List<String> callIds) {
        return metadataStore.findById(cycleId).map(cycle -> {
            int removed = capturedCallsStore.removeByIds(cycleId, callIds);
            return new RemoveCallsResult(removed, callIds.size() - removed);
        });
    }

    /**
     * Manual duplication, not the recording fan-out - works regardless of RECORDING/PAUSED.
     * "Already present" is judged by content (timestamp+method+originalUrl, same identity the
     * frontend's callKey() uses), not by CapturedCall id, since a call copied in has no
     * relationship to any id it might already have elsewhere. Skips within the same batch too,
     * so copying a selection containing the same call twice doesn't add it twice either.
     */
    @Override
    public Optional<CopyCallsResult> copyInto(String cycleId, List<CallRecord> calls) {
        return metadataStore.findById(cycleId).map(cycle -> {
            Set<String> existingKeys = new HashSet<>();
            for (CapturedCall captured : capturedCallsStore.findAllByCycle(cycleId)) {
                existingKeys.add(contentKey(captured.call()));
            }

            int added = 0;
            int skipped = 0;
            for (CallRecord call : calls) {
                String key = contentKey(call);
                if (!existingKeys.add(key)) {
                    skipped++;
                    continue;
                }
                capturedCallsStore.append(cycleId, call);
                added++;
            }
            return new CopyCallsResult(added, skipped);
        });
    }

    private static String contentKey(CallRecord call) {
        return Objects.toString(call.timestamp(), "") + "|" + Objects.toString(call.method(), "") + "|" + Objects.toString(call.originalUrl(), "");
    }
}
