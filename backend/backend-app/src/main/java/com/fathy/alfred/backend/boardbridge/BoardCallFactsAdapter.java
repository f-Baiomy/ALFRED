package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.InvestigateCallUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.TableSummary;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a board re-test reads about one inbound call (specs/016): its status and duration (inbound calls or the cycle
 * that captured it), its statements per table (database capture's Tables view, so a captured call with no statements
 * reads as 0 and an uncaptured one as unknown), its caught ERROR / WARN line counts, and the response values at the
 * JSON paths a SAME_RESPONSE expectation names. Never throws: what cannot be read is left unknown.
 */
@Component
public class BoardCallFactsAdapter implements CallFactsPort {

    private static final Pattern STEP = Pattern.compile("\\.([A-Za-z0-9_\\-]+)|\\[(\\d+)]");
    private static final int MAX_BODY = 8 * 1024 * 1024;

    private final GetCallDetailUseCase liveCalls;
    private final GetCapturedInternalCallDetailUseCase cycleCalls;
    private final GetCallDbSummariesUseCase dbSummaries;
    private final InvestigateCallUseCase tables;
    private final CallLogLinesUseCase logs;
    private final BoardCycleCallsAdapter signer;
    private final ObjectMapper json = new ObjectMapper();

    public BoardCallFactsAdapter(GetCallDetailUseCase liveCalls, GetCapturedInternalCallDetailUseCase cycleCalls,
                                 GetCallDbSummariesUseCase dbSummaries, InvestigateCallUseCase tables, CallLogLinesUseCase logs,
                                 BoardCycleCallsAdapter signer) {
        this.liveCalls = liveCalls;
        this.cycleCalls = cycleCalls;
        this.dbSummaries = dbSummaries;
        this.tables = tables;
        this.logs = logs;
        this.signer = signer;
    }

    @Override
    public Optional<CallFacts> facts(String callId, String cycleId, Set<String> jsonPaths) {
        try {
            Integer status;
            Double duration = null;
            String body = null;
            if (cycleId == null) {
                Optional<CallSummary> summary = liveCalls.getSummary(callId);
                if (summary.isEmpty()) {
                    return Optional.empty();
                }
                status = summary.get().status();
                duration = summary.get().durationMs();
                if (!jsonPaths.isEmpty()) {
                    body = liveCalls.getDetail(callId).map(CallDetail::response).map(r -> r.body()).orElse(null);
                }
            } else {
                Optional<CallDetail> detail = cycleCalls.getDetail(cycleId, callId);
                if (detail.isEmpty()) {
                    return Optional.empty();
                }
                status = detail.get().response() == null ? null : detail.get().response().status();
                body = detail.get().response() == null ? null : detail.get().response().body();
            }
            Integer statements = null;
            Map<String, Integer> byTable = null;
            CallDbSummary db = dbSummaries.summaries(List.of(callId)).get(callId);
            if (db != null) {
                statements = db.statementCount();
                byTable = new HashMap<>();
                for (TableSummary t : tables.tables(callId)) {
                    String name = t.table().replace(" (procedure)", "");
                    byTable.merge(name, t.reads() + t.inserts() + t.updates() + t.failed() + (t.deletedRows() > 0 ? 1 : 0), Integer::sum);
                }
            }
            Integer errors = null;
            Integer warnings = null;
            if (logs.caughtFor(callId)) {
                CaughtLogCounts counts = logs.counts(List.of(callId)).get(callId);
                errors = counts == null ? 0 : counts.errors();
                warnings = counts == null ? 0 : counts.warnings();
            }
            return Optional.of(new CallFacts(status, duration, statements, byTable, errors, warnings, values(body, jsonPaths)));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    @Override
    public Optional<CycleCall> call(String ref) {
        if (ref == null || !ref.startsWith("in:")) {
            return Optional.empty();
        }
        String rest = ref.substring(3);
        if (rest.contains("@")) {
            return Optional.empty(); // a cycle call: its facts carry the status; no duration is kept for it here
        }
        try {
            return liveCalls.getSummary(rest).map(c -> {
                CycleCall signed = signer.call("in", c.id(), c.method(), c.url(), c.status());
                return new CycleCall(signed.direction(), signed.callId(), signed.method(), signed.path(), signed.status(), signed.signature(),
                        BoardCycleCallsAdapter.instant(c.timestamp()), c.durationMs());
            });
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    /** Each path's value in the JSON body as text ({@code .length} of an array or object is its size); unreadable → none. */
    Map<String, String> values(String body, Set<String> paths) {
        if (paths.isEmpty() || body == null || body.isBlank() || body.length() > MAX_BODY) {
            return Map.of();
        }
        JsonNode root;
        try {
            root = json.readTree(body);
        } catch (Exception e) {
            return Map.of();
        }
        Map<String, String> out = new HashMap<>();
        for (String path : paths) {
            String value = value(root, path);
            if (value != null) {
                out.put(path, value);
            }
        }
        return out;
    }

    static String value(JsonNode root, String path) {
        if (root == null || path == null || !path.startsWith("$")) {
            return null;
        }
        boolean length = path.endsWith(".length");
        String steps = length ? path.substring(1, path.length() - ".length".length()) : path.substring(1);
        JsonNode node = root;
        Matcher m = STEP.matcher(steps);
        int pos = 0;
        while (m.find()) {
            if (m.start() != pos) {
                return null;
            }
            pos = m.end();
            node = m.group(1) != null ? node.get(m.group(1)) : node.get(Integer.parseInt(m.group(2)));
            if (node == null) {
                return null;
            }
        }
        if (pos != steps.length()) {
            return null;
        }
        if (length) {
            return node.isArray() || node.isObject() ? String.valueOf(node.size()) : node.isTextual() ? String.valueOf(node.asText().length()) : null;
        }
        return node.isValueNode() ? node.asText() : node.toString();
    }
}
