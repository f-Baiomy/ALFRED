package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.CompleteCallCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.RecordAgentHeartbeatUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Ingest from the agents, their heartbeats, and deletion with the call. Reads live in DbCaptureQueryService.
 *
 * <p>After a batch is stored, each call it touched has its transactions and summary recomputed from the store
 * (cheap: one call's statements, indexed by call), then the {@link IngestListener}s run - flag computation and the
 * size cap - and one {@code statements-appended} signal goes out per call.
 */
@Service
public class DbCaptureService implements IngestStatementsUseCase, RecordAgentHeartbeatUseCase, DeleteCallStatementsUseCase,
        CompleteCallCaptureUseCase {

    private final DbCaptureStorePort store;
    private final DbCaptureNotificationPort notifications;
    private final DbCaptureTogglePort toggle;
    private final List<IngestListener> listeners;
    private final Clock clock;

    public DbCaptureService(DbCaptureStorePort store, DbCaptureNotificationPort notifications, DbCaptureTogglePort toggle,
                            List<IngestListener> listeners, Optional<Clock> clock) {
        this.store = store;
        this.notifications = notifications;
        this.toggle = toggle;
        this.listeners = listeners;
        this.clock = clock.orElse(Clock.systemUTC());
    }

    @Override
    public IngestResult ingest(IngestBatch batch) {
        List<IncomingStatement> statements = batch.statements() == null ? List.of() : batch.statements();
        List<CallMarker> markers = batch.markers() == null ? List.of() : batch.markers();
        int fresh = store.saveStatements(statements);
        store.saveMarkers(markers);

        Map<String, Integer> lastSeqByCall = new LinkedHashMap<>();
        statements.stream().filter(s -> s.callId() != null)
                .forEach(s -> lastSeqByCall.merge(s.callId(), s.seq(), Math::max));
        markers.forEach(m -> lastSeqByCall.merge(m.callId(), m.seq(), Math::max));
        for (Map.Entry<String, Integer> entry : lastSeqByCall.entrySet()) {
            store.refreshTransactions(entry.getKey());
            store.refreshSummary(entry.getKey());
            if (batch.project() != null && !batch.project().isBlank()) {
                store.setCallProject(entry.getKey(), batch.project());
            }
        }
        store.addDropped(batch.droppedByCall());
        for (String callId : lastSeqByCall.keySet()) {
            listeners.forEach(listener -> listener.callIngested(callId));
            notifications.statementsAppended(callId, lastSeqByCall.get(callId), true);
        }
        statements.stream().filter(s -> s.callId() == null).map(IncomingStatement::thread).filter(Objects::nonNull).distinct()
                .forEach(thread -> notifications.outsideAppended(thread,
                        (int) statements.stream().filter(s -> s.callId() == null && thread.equals(s.thread())).count()));
        listeners.forEach(IngestListener::batchIngested);
        return new IngestResult(fresh, statements.size() - fresh);
    }

    @Override
    public AgentDirective heartbeat(AgentStatus status) {
        Instant now = clock.instant();
        boolean wasAttached = store.agents().stream()
                .filter(a -> a.agentId().equals(status.agentId()))
                .anyMatch(a -> isRecent(a.lastSeen(), now));
        store.saveAgent(status.seenAt(now.toString()));
        if (!wasAttached) {
            notifications.agentStatusChanged(status.project(), true);
        }
        return new AgentDirective(store.settings(status.project()), toggle.isEnabled(status.project()));
    }

    static boolean isRecent(String lastSeen, Instant now) {
        if (lastSeen == null) {
            return false;
        }
        return Duration.between(Instant.parse(lastSeen), now).getSeconds() <= AgentStatus.ATTACHED_WITHIN_SECONDS;
    }

    @Override
    public int deleteForCalls(Collection<String> callIds) {
        if (callIds == null || callIds.isEmpty()) {
            return 0;
        }
        return store.deleteForCalls(callIds);
    }

    @Override
    public void deleteAllCallStatements() {
        store.deleteAllCallStatements();
    }

    @Override
    public int deleteForRuns(Collection<String> runIds) {
        if (runIds == null || runIds.isEmpty()) {
            return 0;
        }
        return deleteForCalls(store.callIdsOfRuns(runIds));
    }

    /**
     * A failure the call answered below 500 over was swallowed (the app carried on as if nothing happened). No status
     * at all - a transport error - while the capture was still open means the application died mid-call.
     */
    @Override
    public void callCompleted(String callId, Integer status, String error) {
        if (callId == null || callId.isBlank()) {
            return;
        }
        Optional<com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary> summary = store.summary(callId);
        if (summary.isEmpty()) {
            return;
        }
        boolean answered = status != null && status > 0;
        if (summary.get().failedCount() > 0) {
            store.markFailuresSwallowed(callId, answered && status < 500);
        }
        store.markComplete(callId, !answered && error != null && !error.isBlank() && !summary.get().complete());
        listeners.forEach(listener -> listener.callIngested(callId));
        notifications.statementsAppended(callId, summary.get().lastSeq(), true);
    }
}
