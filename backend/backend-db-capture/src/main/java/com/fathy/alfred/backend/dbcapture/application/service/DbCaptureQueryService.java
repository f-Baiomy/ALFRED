package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.in.ExportCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetStatementUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.IngestStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbCaptureExport;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.ExportedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.RowsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Reads for the ◆ DB chip and the database window. Every size the client asks for is clamped here. */
@Service
public class DbCaptureQueryService implements GetCallDbSummariesUseCase, GetCallStatementsUseCase, GetStatementUseCase,
        ExportCallStatementsUseCase {

    static final String RESULT = "RESULT";
    static final String BEFORE_IMAGE = "BEFORE_IMAGE";

    static final String IMPORT_AGENT = "import";

    private final DbCaptureStorePort store;
    private final IngestStatementsUseCase ingest;

    public DbCaptureQueryService(DbCaptureStorePort store, IngestStatementsUseCase ingest) {
        this.store = store;
        this.ingest = ingest;
    }

    @Override
    public Map<String, CallDbSummary> summaries(List<String> callIds) {
        List<String> ids = callIds.stream().filter(id -> id != null && !id.isBlank()).distinct().limit(MAX_IDS).toList();
        return ids.isEmpty() ? Map.of() : store.summaries(ids);
    }

    @Override
    public CallStatementsPage statements(String callId, int afterSeq, int limit) {
        int clamped = clamp(limit, 1, MAX_LIMIT);
        List<CapturedStatement> page = store.statementsAfter(callId, Math.max(-1, afterSeq), clamped + 1);
        boolean hasMore = page.size() > clamped;
        List<CapturedStatement> statements = hasMore ? page.subList(0, clamped) : page;
        // Markers are few per call; the window needs every supplier position, not only those after afterSeq.
        List<CallMarker> supplierMarkers = store.markers(callId).stream().filter(m -> m.type() == MarkerType.HTTP_OUT).toList();
        return new CallStatementsPage(statements, store.transactions(callId), supplierMarkers, hasMore);
    }

    @Override
    public CallStatementsPage outside(String thread, int offset, int limit) {
        int clamped = clamp(limit, 1, MAX_LIMIT);
        List<CapturedStatement> page = store.outsideStatements(thread, Math.max(0, offset), clamped + 1);
        boolean hasMore = page.size() > clamped;
        return new CallStatementsPage(hasMore ? page.subList(0, clamped) : page, List.of(), List.of(), hasMore);
    }

    @Override
    public Optional<CapturedStatement> statement(long id) {
        return store.statement(id);
    }

    @Override
    public Optional<RowsPage> rows(long id, String part, int offset, int limit) {
        String safePart = BEFORE_IMAGE.equals(part) ? BEFORE_IMAGE : RESULT;
        return store.statement(id).map(statement -> {
            StatementOutcome outcome = statement.outcome();
            boolean result = RESULT.equals(safePart);
            return new RowsPage(store.columns(id, safePart), store.rows(id, safePart, Math.max(0, offset), clamp(limit, 1, MAX_ROWS)),
                    store.rowCount(id, safePart), result ? outcome.rowsRead() : null, result ? outcome.partial() : null,
                    result ? outcome.overLimit() : null);
        });
    }

    @Override
    public Optional<CallDbCaptureExport> export(String callId) {
        Optional<CallDbSummary> summary = store.summary(callId);
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        List<ExportedStatement> statements = store.allStatements(callId, Integer.MAX_VALUE).stream()
                .map(s -> ExportedStatement.of(s,
                        s.storedRows() > 0 ? store.rows(s.id(), RESULT, 0, Integer.MAX_VALUE) : List.of(),
                        s.beforeImage() != null ? store.rows(s.id(), BEFORE_IMAGE, 0, Integer.MAX_VALUE) : List.of()))
                .toList();
        List<CallMarker> supplierMarkers = store.markers(callId).stream().filter(m -> m.type() == MarkerType.HTTP_OUT).toList();
        return Optional.of(new CallDbCaptureExport(summary.get(), store.transactions(callId), supplierMarkers, statements));
    }

    /**
     * Re-import goes through the same ingest as the agent - transactions and the summary are recomputed from the
     * statements, never trusted from the file. Statement ids are re-assigned; the sid ("import:callId:seq") makes a
     * second import of the same file a no-op.
     */
    @Override
    public int importCaptures(Map<String, CallDbCaptureExport> byCallId) {
        int stored = 0;
        for (Map.Entry<String, CallDbCaptureExport> entry : byCallId.entrySet()) {
            String callId = entry.getKey();
            CallDbCaptureExport capture = entry.getValue();
            if (callId == null || callId.isBlank() || capture == null) {
                continue;
            }
            List<IncomingStatement> statements = new ArrayList<>();
            for (ExportedStatement s : capture.statements() == null ? List.<ExportedStatement>of() : capture.statements()) {
                statements.add(new IncomingStatement(IMPORT_AGENT + ":" + callId + ":" + s.seq(), callId, s.runTag(), s.thread(), s.seq(),
                        s.kind(), s.sql(), s.fingerprint(), s.table(), s.params(), s.outcome(), s.rows(), 0, s.beforeImageRows(),
                        s.beforeImage(), s.startedAt(), s.durationMicros(), s.offsetMicros(), s.txId(), s.connectionId(),
                        s.codeLocation(), s.dataSource(), s.cascadesTo(), s.origin(), s.callers(), s.indexes()));
            }
            List<CallMarker> markers = new ArrayList<>();
            markers.add(new CallMarker(callId, 0, MarkerType.CALL_OPEN, null, null, null));
            for (CallMarker m : capture.supplierMarkers() == null ? List.<CallMarker>of() : capture.supplierMarkers()) {
                markers.add(new CallMarker(callId, m.seq(), MarkerType.HTTP_OUT, m.at(), m.method(), m.url()));
            }
            stored += ingest.ingest(new IngestBatch(IMPORT_AGENT, null, statements, markers, Map.of())).accepted();
            store.markComplete(callId, capture.summary() != null && capture.summary().endedEarly());
        }
        return stored;
    }

    static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
