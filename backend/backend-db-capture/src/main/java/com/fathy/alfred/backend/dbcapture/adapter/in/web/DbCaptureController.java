package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.ExportCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.FindStatementFailuresUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetStatementUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.InvestigateCallUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryRequest;
import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;
import com.fathy.alfred.backend.dbcapture.domain.model.TableSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.TraceHit;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbCaptureExport;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.RowsPage;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The database window's reads (contracts/rest-api.md). Sizes are clamped in the use cases. */
@RestController
public class DbCaptureController {

    private final GetCallDbSummariesUseCase summaries;
    private final GetCallStatementsUseCase statements;
    private final GetStatementUseCase statement;
    private final DeleteCallStatementsUseCase delete;
    private final ExportCallStatementsUseCase export;
    private final InvestigateCallUseCase investigate;
    private final FindStatementFailuresUseCase failures;

    public DbCaptureController(GetCallDbSummariesUseCase summaries, GetCallStatementsUseCase statements, GetStatementUseCase statement,
                               DeleteCallStatementsUseCase delete, ExportCallStatementsUseCase export, InvestigateCallUseCase investigate,
                               FindStatementFailuresUseCase failures) {
        this.failures = failures;
        this.summaries = summaries;
        this.statements = statements;
        this.statement = statement;
        this.delete = delete;
        this.export = export;
        this.investigate = investigate;
    }

    /** Search or SQL over one statement's stored rows (table {@code result}) - recorded data only. */
    @PostMapping("/db-capture/statements/{id}/rows/query")
    public ResponseEntity<RecordedQueryResult> queryRows(@PathVariable long id, @RequestParam(defaultValue = "RESULT") String part,
                                                         @RequestBody RecordedQueryRequest request) {
        return investigate.queryRows(id, part, request).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Search or SQL over a call's statements (table {@code statements}); {@code statementSeqs} when {@code n} is selected. */
    @PostMapping("/db-capture/calls/{callId}/statements/query")
    public RecordedQueryResult queryStatements(@PathVariable String callId, @RequestBody RecordedQueryRequest request) {
        return investigate.queryStatements(callId, request);
    }

    @GetMapping("/db-capture/calls/{callId}/trace")
    public Map<String, List<TraceHit>> trace(@PathVariable String callId, @RequestParam String value) {
        return Map.of("hits", investigate.trace(callId, value));
    }

    @GetMapping("/db-capture/calls/{callId}/tables")
    public List<TableSummary> tables(@PathVariable String callId) {
        return investigate.tables(callId);
    }

    /** Every statement of a call with every stored row - what a .json/.md/.html export embeds. 404 when not captured. */
    @GetMapping("/db-capture/calls/{callId}/export")
    public ResponseEntity<CallDbCaptureExport> export(@PathVariable String callId) {
        return export.export(callId).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Re-import from a .json export: {@code { calls: [{ callId, dbCapture }] }}. A user action, same origin - no secret. */
    @PostMapping("/db-capture/import")
    public Map<String, Integer> importCaptures(@RequestBody ImportRequestDto request) {
        Map<String, CallDbCaptureExport> byCall = new LinkedHashMap<>();
        if (request != null && request.calls() != null) {
            request.calls().stream().filter(c -> c != null && c.callId() != null && c.dbCapture() != null)
                    .forEach(c -> byCall.put(c.callId(), c.dbCapture()));
        }
        return Map.of("imported", export.importCaptures(byCall));
    }

    public record ImportRequestDto(List<ImportedCallDto> calls) {
    }

    public record ImportedCallDto(String callId, CallDbCaptureExport dbCapture) {
    }

    @GetMapping("/db-capture/summaries")
    public Map<String, CallDbSummary> summaries(@RequestParam(defaultValue = "") String callIds) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::strip).filter(s -> !s.isEmpty()).toList();
        return summaries.summaries(ids);
    }

    /** Calls that asked for capture but of which the agent sent nothing: {callId: "db,logs,redis"}. */
    @GetMapping("/db-capture/silent")
    public Map<String, String> silent(@RequestParam(defaultValue = "") String callIds) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::strip).filter(s -> !s.isEmpty()).toList();
        return summaries.silentCalls(ids);
    }

    /** The failed statements of up to 500 calls, from the failed-statement index; more ids is a 400. */
    @GetMapping("/db-capture/failures")
    public ResponseEntity<?> failures(@RequestParam(defaultValue = "") String callIds) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::strip).filter(s -> !s.isEmpty()).toList();
        try {
            return ResponseEntity.ok(failures.failures(ids));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        }
    }

    @GetMapping("/db-capture/calls/{callId}/statements")
    public CallStatementsPage statements(@PathVariable String callId, @RequestParam(defaultValue = "0") int afterSeq,
                                         @RequestParam(defaultValue = "500") int limit) {
        return statements.statements(callId, afterSeq, limit);
    }

    @GetMapping("/db-capture/outside")
    public CallStatementsPage outside(@RequestParam(defaultValue = "") String thread, @RequestParam(defaultValue = "0") int offset,
                                      @RequestParam(defaultValue = "200") int limit) {
        return statements.outside(thread, offset, limit);
    }

    @GetMapping("/db-capture/statements/{id}")
    public ResponseEntity<CapturedStatement> statement(@PathVariable long id) {
        return statement.statement(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/db-capture/statements/{id}/rows")
    public ResponseEntity<RowsPage> rows(@PathVariable long id, @RequestParam(defaultValue = "RESULT") String part,
                                         @RequestParam(defaultValue = "0") int offset, @RequestParam(defaultValue = "100") int limit) {
        return statement.rows(id, part, offset, limit).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/db-capture/calls/{callId}")
    public ResponseEntity<Void> deleteCall(@PathVariable String callId) {
        return delete.deleteForCalls(List.of(callId)) > 0 ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }
}
