package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.CopyCallsRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.CopyInternalCallsRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.CreateSessionCycleRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.RemoveCallsRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.UpdateSessionCycleRequestDto;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ClearCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyInternalCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.DeleteSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCallOverlapsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.RemoveCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.UpdateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.sessioncycles.domain.model.CallOverlapQuery;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleUpdate;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.List;

@RestController
@RequestMapping("/session-cycles")
public class SessionCyclesController {

    private final CreateSessionCycleUseCase createSessionCycleUseCase;
    private final ListSessionCyclesUseCase listSessionCyclesUseCase;
    private final GetSessionCycleUseCase getSessionCycleUseCase;
    private final UpdateSessionCycleUseCase updateSessionCycleUseCase;
    private final StartRecordingUseCase startRecordingUseCase;
    private final PauseRecordingUseCase pauseRecordingUseCase;
    private final DeleteSessionCycleUseCase deleteSessionCycleUseCase;
    private final ListCapturedCallsUseCase listCapturedCallsUseCase;
    private final GetCapturedCallDetailUseCase getCapturedCallDetailUseCase;
    private final RemoveCapturedCallUseCase removeCapturedCallUseCase;
    private final RemoveCapturedCallsUseCase removeCapturedCallsUseCase;
    private final ClearCapturedCallsUseCase clearCapturedCallsUseCase;
    private final CopyCallsToCycleUseCase copyCallsToCycleUseCase;
    private final ListCapturedInternalCallsUseCase listCapturedInternalCallsUseCase;
    private final GetCapturedInternalCallDetailUseCase getCapturedInternalCallDetailUseCase;
    private final RemoveCapturedInternalCallUseCase removeCapturedInternalCallUseCase;
    private final RemoveCapturedInternalCallsUseCase removeCapturedInternalCallsUseCase;
    private final CopyInternalCallsToCycleUseCase copyInternalCallsToCycleUseCase;
    private final ListCallOverlapsUseCase listCallOverlapsUseCase;

    public SessionCyclesController(
            CreateSessionCycleUseCase createSessionCycleUseCase,
            ListSessionCyclesUseCase listSessionCyclesUseCase,
            GetSessionCycleUseCase getSessionCycleUseCase,
            UpdateSessionCycleUseCase updateSessionCycleUseCase,
            StartRecordingUseCase startRecordingUseCase,
            PauseRecordingUseCase pauseRecordingUseCase,
            DeleteSessionCycleUseCase deleteSessionCycleUseCase,
            ListCapturedCallsUseCase listCapturedCallsUseCase,
            GetCapturedCallDetailUseCase getCapturedCallDetailUseCase,
            RemoveCapturedCallUseCase removeCapturedCallUseCase,
            RemoveCapturedCallsUseCase removeCapturedCallsUseCase,
            ClearCapturedCallsUseCase clearCapturedCallsUseCase,
            CopyCallsToCycleUseCase copyCallsToCycleUseCase,
            ListCapturedInternalCallsUseCase listCapturedInternalCallsUseCase,
            GetCapturedInternalCallDetailUseCase getCapturedInternalCallDetailUseCase,
            RemoveCapturedInternalCallUseCase removeCapturedInternalCallUseCase,
            RemoveCapturedInternalCallsUseCase removeCapturedInternalCallsUseCase,
            CopyInternalCallsToCycleUseCase copyInternalCallsToCycleUseCase,
            ListCallOverlapsUseCase listCallOverlapsUseCase
    ) {
        this.createSessionCycleUseCase = createSessionCycleUseCase;
        this.listSessionCyclesUseCase = listSessionCyclesUseCase;
        this.getSessionCycleUseCase = getSessionCycleUseCase;
        this.updateSessionCycleUseCase = updateSessionCycleUseCase;
        this.startRecordingUseCase = startRecordingUseCase;
        this.pauseRecordingUseCase = pauseRecordingUseCase;
        this.deleteSessionCycleUseCase = deleteSessionCycleUseCase;
        this.listCapturedCallsUseCase = listCapturedCallsUseCase;
        this.getCapturedCallDetailUseCase = getCapturedCallDetailUseCase;
        this.removeCapturedCallUseCase = removeCapturedCallUseCase;
        this.removeCapturedCallsUseCase = removeCapturedCallsUseCase;
        this.clearCapturedCallsUseCase = clearCapturedCallsUseCase;
        this.copyCallsToCycleUseCase = copyCallsToCycleUseCase;
        this.listCapturedInternalCallsUseCase = listCapturedInternalCallsUseCase;
        this.getCapturedInternalCallDetailUseCase = getCapturedInternalCallDetailUseCase;
        this.removeCapturedInternalCallUseCase = removeCapturedInternalCallUseCase;
        this.removeCapturedInternalCallsUseCase = removeCapturedInternalCallsUseCase;
        this.copyInternalCallsToCycleUseCase = copyInternalCallsToCycleUseCase;
        this.listCallOverlapsUseCase = listCallOverlapsUseCase;
    }

    @PostMapping
    public ResponseEntity<SessionCycle> create(@Valid @RequestBody CreateSessionCycleRequestDto request) {
        SessionCycle created = createSessionCycleUseCase.create(new NewSessionCycle(request.name(), request.assignedTo()));
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping
    public List<SessionCycle> list() {
        return listSessionCyclesUseCase.listAll();
    }

    @GetMapping("/{id}")
    public ResponseEntity<SessionCycle> get(@PathVariable String id) {
        return getSessionCycleUseCase.getById(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PatchMapping("/{id}")
    public ResponseEntity<SessionCycle> update(@PathVariable String id, @RequestBody UpdateSessionCycleRequestDto request) {
        return updateSessionCycleUseCase.update(id, new SessionCycleUpdate(request.name(), request.assignedTo()))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/record")
    public ResponseEntity<SessionCycle> startRecording(@PathVariable String id) {
        return startRecordingUseCase.startRecording(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/{id}/pause")
    public ResponseEntity<SessionCycle> pauseRecording(@PathVariable String id) {
        return pauseRecordingUseCase.pauseRecording(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        DeleteOutcome outcome = deleteSessionCycleUseCase.delete(id);
        return switch (outcome) {
            case DELETED -> ResponseEntity.noContent().build();
            case NOT_FOUND -> ResponseEntity.notFound().build();
            case BLOCKED_RECORDING -> ResponseEntity.status(HttpStatus.CONFLICT).build();
        };
    }

    /** Server-side filtered/sorted/paginated, same contract as GET /calls. */
    @GetMapping("/{id}/calls")
    public ResponseEntity<CapturedCallsPage> listCalls(
            @PathVariable String id,
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "oldest-call") String sort,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "10") int limit,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId
    ) {
        return listCapturedCallsUseCase.listCalls(id, new CallsQuery(search, supplier, sort, offset, limit, sessionId, operationId, requestId))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * The request/response (headers+bodies) for one captured call - fetched only once it's actually
     * expanded. {@code part} narrows it to a single block, exactly as on GET /calls/{id}/detail;
     * omitted, the whole detail comes back as before.
     */
    @GetMapping("/{id}/calls/{callId}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id, @PathVariable String callId, @RequestParam(required = false) String part) {
        return getCapturedCallDetailUseCase.getDetail(id, callId)
                .map(detail -> detail.part(part))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}/calls/{callId}")
    public ResponseEntity<Void> removeCall(@PathVariable String id, @PathVariable String callId) {
        boolean removed = removeCapturedCallUseCase.removeCall(id, callId);
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @PostMapping("/{id}/calls/remove")
    public ResponseEntity<RemoveCallsResult> removeCalls(@PathVariable String id, @Valid @RequestBody RemoveCallsRequestDto request) {
        return removeCapturedCallsUseCase.removeCalls(id, request.callIds())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Clears both external and internal captured calls for this cycle in one shot - the cycle's own record (name/status/assignee) is untouched. */
    @PostMapping("/{id}/calls/clear")
    public ResponseEntity<Void> clearCalls(@PathVariable String id) {
        boolean cleared = clearCapturedCallsUseCase.clearCalls(id);
        return cleared ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @PostMapping("/{id}/calls/copy")
    public ResponseEntity<CopyCallsResult> copyCalls(@PathVariable String id, @Valid @RequestBody CopyCallsRequestDto request) {
        return copyCallsToCycleUseCase.copyInto(id, request.calls())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Internal-calls mirror of GET /session-cycles/{id}/calls (frontend->WildFly traffic, via
     * backend-internal-calls) - same query params/contract, same default sort.
     */
    @GetMapping("/{id}/internal-calls")
    public ResponseEntity<CapturedInternalCallsPage> listInternalCalls(
            @PathVariable String id,
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "oldest-call") String sort,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "10") int limit,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId,
            @RequestParam(defaultValue = "") String serviceNames
    ) {
        return listCapturedInternalCallsUseCase.listCalls(id, new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery(
                        search, supplier, sort, offset, limit, sessionId, operationId, requestId, serviceNames))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** As GET /{id}/calls/{callId}/detail above, for a captured internal call. */
    @GetMapping("/{id}/internal-calls/{callId}/detail")
    public ResponseEntity<com.fathy.alfred.backend.internalcalls.domain.model.CallDetail> getInternalCallDetail(@PathVariable String id, @PathVariable String callId, @RequestParam(required = false) String part) {
        return getCapturedInternalCallDetailUseCase.getDetail(id, callId)
                .map(detail -> detail.part(part))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}/internal-calls/{callId}")
    public ResponseEntity<Void> removeInternalCall(@PathVariable String id, @PathVariable String callId) {
        boolean removed = removeCapturedInternalCallUseCase.removeCall(id, callId);
        return removed ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @PostMapping("/{id}/internal-calls/remove")
    public ResponseEntity<RemoveCallsResult> removeInternalCalls(@PathVariable String id, @Valid @RequestBody RemoveCallsRequestDto request) {
        return removeCapturedInternalCallsUseCase.removeCalls(id, request.callIds())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Internal-calls mirror of POST /session-cycles/{id}/calls/copy - manual duplication, works regardless of RECORDING/PAUSED. */
    @PostMapping("/{id}/internal-calls/copy")
    public ResponseEntity<CopyCallsResult> copyInternalCalls(@PathVariable String id, @Valid @RequestBody CopyInternalCallsRequestDto request) {
        return copyInternalCallsToCycleUseCase.copyInto(id, request.calls())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Windowed+filtered "what calls (external + internal) happened in this time range", scoped to
     * this cycle's own captured calls rather than the global live calls tables (see
     * backend-call-overlap's GET /call-overlaps for that) - built for the frontend's own
     * containment/nesting check, not for browsing/pagination. {@code from}/{@code to} are required
     * ISO-8601 instants; every other param is optional and blank/absent means "no filter", same
     * convention as GET /session-cycles/{id}/calls and GET /session-cycles/{id}/internal-calls.
     */
    @GetMapping("/{id}/call-overlaps")
    public ResponseEntity<List<CallOverlapEntry>> listCallOverlaps(
            @PathVariable String id,
            @RequestParam String from,
            @RequestParam String to,
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "") String serviceNames,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId
    ) {
        Instant fromInstant = parseInstant("from", from);
        Instant toInstant = parseInstant("to", to);
        return listCallOverlapsUseCase.listCallOverlaps(id, new CallOverlapQuery(
                        fromInstant, toInstant, search, supplier, serviceNames, sessionId, operationId, requestId))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Accepts both Java's Instant.toString() format (trailing "Z") and an OffsetDateTime-shaped offset, same fallback CallListSupport's own timestamp parsing uses elsewhere. */
    private static Instant parseInstant(String paramName, String value) {
        try {
            return Instant.parse(value);
        } catch (DateTimeParseException e) {
            try {
                return OffsetDateTime.parse(value).toInstant();
            } catch (DateTimeParseException e2) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid " + paramName + " - expected an ISO-8601 timestamp");
            }
        }
    }
}
