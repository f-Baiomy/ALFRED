package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyInternalCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * Internal-calls mirror of SessionCyclesService's captured-call read/remove use cases (frontend->
 * WildFly traffic, via backend-internal-calls). Kept as its own class rather than folded into
 * SessionCyclesService: GetCapturedInternalCallDetailUseCase/RemoveCapturedInternalCallUseCase/
 * RemoveCapturedInternalCallsUseCase declare methods whose parameter lists are identical (after
 * generic erasure) to SessionCyclesService's own GetCapturedCallDetailUseCase/
 * RemoveCapturedCallUseCase/RemoveCapturedCallsUseCase methods - one class cannot implement both
 * sets (a getDetail(String,String) returning a different generic Optional<...> after erasure is a
 * compile error, and a removeCall(String,String)/removeCalls(String,List<String>) with an
 * identical signature+return type would silently collapse the two logically-different operations
 * onto a single shared method body). Session-cycle create/update/record/pause/delete lifecycle
 * management stays solely on SessionCyclesService; this class only ever reads a cycle's identity
 * via {@link SessionCycleMetadataStorePort#findById}, exactly like SessionCyclesService's own
 * external-path methods do.
 */
@Service
public class SessionCyclesInternalCallsService implements
        ListCapturedInternalCallsUseCase,
        GetCapturedInternalCallDetailUseCase,
        RemoveCapturedInternalCallUseCase,
        RemoveCapturedInternalCallsUseCase,
        CopyInternalCallsToCycleUseCase {

    private final SessionCycleMetadataStorePort metadataStore;
    private final CapturedInternalCallsStorePort capturedInternalCallsStore;

    /** Same property + same clamp SessionCyclesService applies to the external captured-calls path, reused here so a page of captured internal calls can't be forced unbounded either. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

    /** Same property SessionCyclesService's external path reuses - deliberately not a separate internal-calls-specific property. */
    @Value("${alfred.session-cycles.pagination-enabled:false}")
    private boolean paginationEnabled;

    public SessionCyclesInternalCallsService(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore) {
        this.metadataStore = metadataStore;
        this.capturedInternalCallsStore = capturedInternalCallsStore;
    }

    /** Mirrors SessionCyclesService.listCalls exactly, delegating to CapturedInternalCallsStorePort instead. */
    @Override
    public Optional<CapturedInternalCallsPage> listCalls(String cycleId, CallsQuery query) {
        return metadataStore.findById(cycleId).map(cycle -> {
            int clampedOffset = Math.max(0, query.offset());
            // Disabled pagination means "everything up to maxLimit in one response" - see
            // CallsService.getCalls for why query.limit() must not be used here in that case.
            int clampedLimit = paginationEnabled ? Math.max(1, Math.min(query.limit(), maxLimit)) : maxLimit;

            CallListSupport.Page<CapturedInternalCallSummary> page = capturedInternalCallsStore.query(
                    cycleId, query.search(), query.supplier(), query.sort(), clampedOffset, clampedLimit, paginationEnabled,
                    query.sessionId(), query.operationId(), query.requestId());
            return new CapturedInternalCallsPage(page.items(), page.total());
        });
    }

    /** Mirrors SessionCyclesService.getDetail exactly, scoped to this cycle's own captured-internal-calls file. */
    @Override
    public Optional<CallDetail> getDetail(String cycleId, String callId) {
        if (metadataStore.findById(cycleId).isEmpty()) {
            return Optional.empty();
        }
        return capturedInternalCallsStore.findByCallId(cycleId, callId).map(captured -> CallDetail.of(captured.call()));
    }

    @Override
    public boolean removeCall(String cycleId, String callId) {
        return capturedInternalCallsStore.removeById(cycleId, callId);
    }

    @Override
    public Optional<RemoveCallsResult> removeCalls(String cycleId, List<String> callIds) {
        return metadataStore.findById(cycleId).map(cycle -> {
            int removed = capturedInternalCallsStore.removeByIds(cycleId, callIds);
            return new RemoveCallsResult(removed, callIds.size() - removed);
        });
    }

    /** Mirrors SessionCyclesService.copyInto exactly, delegating to CapturedInternalCallsStorePort instead - manual duplication, not the recording fan-out, so it works regardless of RECORDING/PAUSED. */
    @Override
    public Optional<CopyCallsResult> copyInto(String cycleId, List<CallRecord> calls) {
        return metadataStore.findById(cycleId).map(cycle -> {
            Set<String> existingIds = new HashSet<>();
            for (CapturedInternalCall captured : capturedInternalCallsStore.findAllByCycle(cycleId)) {
                existingIds.add(captured.call().id());
            }

            int added = 0;
            int skipped = 0;
            for (CallRecord call : calls) {
                if (!existingIds.add(call.id())) {
                    skipped++;
                    continue;
                }
                capturedInternalCallsStore.append(cycleId, call);
                added++;
            }
            return new CopyCallsResult(added, skipped);
        });
    }
}
