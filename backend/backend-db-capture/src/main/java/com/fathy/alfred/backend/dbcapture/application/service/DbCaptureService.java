package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import com.fathy.alfred.backend.dbcapture.application.port.in.CompleteCallCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.RecordAgentHeartbeatUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.StatementFailuresObserverPort;
import com.fathy.alfred.backend.dbcapture.domain.DeletedRowsResolver;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentDirective;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestResult;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
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

    /** How far back in a call the earlier-read lookup searches. */
    static final int MAX_EARLIER_READS = 5_000;

    private final DbCaptureStorePort store;
    private final DbCaptureNotificationPort notifications;
    private final DbCaptureTogglePort toggle;
    private final List<IngestListener> listeners;
    private final Clock clock;
    private final List<StatementFailuresObserverPort> failureObservers;

    public DbCaptureService(DbCaptureStorePort store, DbCaptureNotificationPort notifications, DbCaptureTogglePort toggle,
                            List<IngestListener> listeners, Optional<Clock> clock) {
        this(store, notifications, toggle, listeners, clock, List.of());
    }

    @Autowired
    public DbCaptureService(DbCaptureStorePort store, DbCaptureNotificationPort notifications, DbCaptureTogglePort toggle,
                            List<IngestListener> listeners, Optional<Clock> clock, List<StatementFailuresObserverPort> failureObservers) {
        this.store = store;
        this.notifications = notifications;
        this.toggle = toggle;
        this.listeners = listeners;
        this.clock = clock.orElse(Clock.systemUTC());
        this.failureObservers = failureObservers;
    }

    /** Hands changed calls' log and database signals to triage (specs/010). Optional for tests. */
    private CallSignalsPublisher signals;

    @Autowired(required = false)
    void setSignals(CallSignalsPublisher signals) {
        this.signals = signals;
    }

    /** The ▤ switch - outside-call lines are caught while it is on (specs/009-agent-log-capture). Optional for tests. */
    private com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort logLink;

    @Autowired(required = false)
    void setLogLink(com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort logLink) {
        this.logLink = logLink;
    }

    @Override
    public IngestResult ingest(IngestBatch batch) {
        List<IncomingStatement> statements = withEarlierReads(batch.statements() == null ? List.of() : batch.statements());
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
        List<CaughtLogLine> logs = batch.logs() == null ? List.of() : batch.logs();
        store.saveLogLines(logs);
        store.addDroppedLogs(batch.droppedLogs());
        logs.stream().map(l -> java.util.Arrays.asList(l.callId(), l.project())).distinct()
                .forEach(k -> notifications.logsAppended(k.get(0), k.get(1)));
        // Only calls this batch gave a failed statement: a statement never stops having failed, so the counts of a
        // call with none in this batch did not change.
        statements.stream().filter(s -> s.callId() != null && s.outcome() != null && s.outcome().failed())
                .map(IncomingStatement::callId).distinct().forEach(this::publishFailures);
        for (String callId : lastSeqByCall.keySet()) {
            listeners.forEach(listener -> listener.callIngested(callId));
            notifications.statementsAppended(callId, lastSeqByCall.get(callId), true);
        }
        statements.stream().filter(s -> s.callId() == null).map(IncomingStatement::thread).filter(Objects::nonNull).distinct()
                .forEach(thread -> notifications.outsideAppended(thread,
                        (int) statements.stream().filter(s -> s.callId() == null && thread.equals(s.thread())).count()));
        listeners.forEach(IngestListener::batchIngested);
        if (signals != null) {
            // after the listeners: flags are recomputed by then. Calls whose lines or statements this batch brought.
            java.util.Set<String> changed = new java.util.LinkedHashSet<>(lastSeqByCall.keySet());
            logs.stream().map(CaughtLogLine::callId).filter(Objects::nonNull).forEach(changed::add);
            signals.publish(changed);
        }
        return new IngestResult(fresh, statements.size() - fresh);
    }

    /**
     * An UPDATE/DELETE the agent did not read rows for gets them from the latest earlier read of the same rows in the
     * same call, when there is one (DeletedRowsResolver) - looked up only for calls in this batch that have such a write.
     */
    private List<IncomingStatement> withEarlierReads(List<IncomingStatement> statements) {
        boolean any = statements.stream().anyMatch(DbCaptureService::needsEarlierRead);
        if (!any) {
            return statements;
        }
        Map<String, List<DeletedRowsResolver.Read>> readsByCall = new LinkedHashMap<>();
        List<IncomingStatement> out = new ArrayList<>(statements.size());
        for (IncomingStatement s : statements) {
            List<DeletedRowsResolver.Read> reads = s.callId() == null ? null : readsByCall.computeIfAbsent(s.callId(), id ->
                    new ArrayList<>(store.allStatements(id, MAX_EARLIER_READS).stream()
                            .map(c -> new DeletedRowsResolver.Read(c.seq(), c.kind(), c.sql(), c.table(), c.params().isEmpty() ? List.of() : c.params().get(0),
                                    c.outcome(), c.storedRows()))
                            .toList()));
            IncomingStatement next = s;
            if (reads != null && needsEarlierRead(s)) {
                BeforeImage found = DeletedRowsResolver.resolve(s.sql(), s.table(), s.params() == null || s.params().isEmpty() ? List.of() : s.params().get(0),
                        reads.stream().filter(r -> r.seq() < s.seq()).toList());
                if (found != null) {
                    next = withBeforeImage(s, found);
                }
            }
            if (reads != null && s.rowsFrom() == 0) {
                reads.add(new DeletedRowsResolver.Read(s.seq(), s.kind(), s.sql(), s.table(), s.params() == null || s.params().isEmpty() ? List.of() : s.params().get(0),
                        s.outcome(), s.rows() == null ? 0 : s.rows().size()));
            }
            out.add(next);
        }
        return out;
    }

    private static boolean needsEarlierRead(IncomingStatement s) {
        return s.callId() != null && s.rowsFrom() == 0 && (s.kind() == StatementKind.DELETE || s.kind() == StatementKind.UPDATE)
                && (s.beforeImage() == null || BeforeImage.NONE.equals(s.beforeImage().source()));
    }

    private static IncomingStatement withBeforeImage(IncomingStatement s, BeforeImage image) {
        return new IncomingStatement(s.sid(), s.callId(), s.runTag(), s.thread(), s.seq(), s.kind(), s.sql(), s.fingerprint(), s.table(),
                s.params(), s.outcome(), s.rows(), s.rowsFrom(), s.beforeImageRows(), image, s.startedAt(), s.durationMicros(),
                s.offsetMicros(), s.txId(), s.connectionId(), s.codeLocation(), s.dataSource(), s.cascadesTo(), s.origin(), s.callers(), s.indexes());
    }

    private void publishFailures(String callId) {
        if (failureObservers.isEmpty()) {
            return;
        }
        FailureCounts counts = store.failureCounts(callId);
        failureObservers.forEach(observer -> observer.failuresChanged(callId, counts.failed(), counts.swallowed()));
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
        return new AgentDirective(store.settings(status.project()), toggle.isEnabled(status.project()),
                logLink != null && logLink.isOn(status.project()));
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
            publishFailures(callId);
        }
        store.markComplete(callId, !answered && error != null && !error.isBlank() && !summary.get().complete());
        listeners.forEach(listener -> listener.callIngested(callId));
        notifications.statementsAppended(callId, summary.get().lastSeq(), true);
        if (signals != null) {
            signals.publish(List.of(callId)); // flags are final now
        }
    }
}
