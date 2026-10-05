package com.fathy.alfred.backend.dbcapture.application.port.out;

import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.FailureCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementTransaction;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** Everything database capture keeps (db-capture.db). Every list read is windowed; rows are paged. */
public interface DbCaptureStorePort {

    /** Saves new statements (ignoring sids already stored) and appends continuation rows. Returns how many were new. */
    int saveStatements(List<IncomingStatement> statements);

    void saveMarkers(List<CallMarker> markers);

    void addDropped(Map<String, Long> droppedByCall);

    /** Marks every statement of a rolled-back transaction as undone and upserts the transaction rows of these calls. */
    void refreshTransactions(String callId);

    /** Recounts a call's summary from its stored statements (creating it if a marker or statement exists). */
    void refreshSummary(String callId);

    void saveFlags(String callId, List<DbFlag> flags);

    /** Of these calls, the ones whose stored flags were computed by older rules (StatementFlags.VERSION). */
    List<String> withStaleFlags(Collection<String> callIds);

    /** Records which project a call's statements came from (its agent's), once - settings and flags are per project. */
    void setCallProject(String callId, String project);

    Optional<String> callProject(String callId);

    void markComplete(String callId, boolean endedEarly);

    /** Sets {@code swallowed} on every failed statement of the call - decided once the call's own status is known. */
    void markFailuresSwallowed(String callId, boolean swallowed);

    /** Calls whose statements carry a run tag of one of these Relive runs ({@code runId/stepKey}). */
    List<String> callIdsOfRuns(Collection<String> runIds);

    Map<String, CallDbSummary> summaries(Collection<String> callIds);

    /** The failed statements of these calls, in seq order, at most {@code perCall} each - read from the failed index only. */
    Map<String, List<CapturedStatement>> failedStatements(Collection<String> callIds, int perCall);

    /** A call's failed and swallowed statement counts, from the failed index. */
    FailureCounts failureCounts(String callId);

    Optional<CallDbSummary> summary(String callId);

    /** A call's statements after {@code afterSeq}, in order - full records without rows. */
    List<CapturedStatement> statementsAfter(String callId, int afterSeq, int limit);

    /** Every statement of a call, in order - used by flag computation and queries; bounded by the caller's limit. */
    List<CapturedStatement> allStatements(String callId, int limit);

    List<CapturedStatement> outsideStatements(String thread, int offset, int limit);

    List<StatementTransaction> transactions(String callId);

    List<CallMarker> markers(String callId);

    Optional<CapturedStatement> statement(long id);

    List<Column> columns(long statementId, String part);

    List<List<TypedValue>> rows(long statementId, String part, int offset, int limit);

    long rowCount(long statementId, String part);

    /** Stored result / before-image cells of a call equal to {@code value} - for value tracing. */
    List<com.fathy.alfred.backend.dbcapture.domain.model.TraceHit> rowsContaining(String callId, String value, int limit);

    /** Removes every statement, row, transaction, marker and summary of these calls. */
    int deleteForCalls(Collection<String> callIds);

    void deleteAllCallStatements();

    /** Bytes used, for the size cap. */
    long totalBytes();

    /** Oldest-first call ids for eviction, skipping {@code keep} and every call with Relive-run statements. */
    List<String> oldestCallIds(int limit, Set<String> keep);

    /** Removes outside-call statements older than {@code beforeInstant}, or the oldest ones past {@code maxBytes}. */
    void trimOutside(String beforeInstant, long maxBytes);

    DbCaptureSettings settings(String project);

    void saveSettings(String project, DbCaptureSettings settings);

    void saveAgent(AgentStatus status);

    List<AgentStatus> agents();
}
