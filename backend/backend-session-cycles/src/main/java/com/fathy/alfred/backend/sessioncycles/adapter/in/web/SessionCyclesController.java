package com.fathy.alfred.backend.sessioncycles.adapter.in.web;

import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.CopyCallsRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.CreateSessionCycleRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.RemoveCallsRequestDto;
import com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto.UpdateSessionCycleRequestDto;
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
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage;
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
    private final CopyCallsToCycleUseCase copyCallsToCycleUseCase;

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
            CopyCallsToCycleUseCase copyCallsToCycleUseCase
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
        this.copyCallsToCycleUseCase = copyCallsToCycleUseCase;
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

    /** The full request/response (headers+bodies) for one captured call - fetched only once it's actually expanded. */
    @GetMapping("/{id}/calls/{callId}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id, @PathVariable String callId) {
        return getCapturedCallDetailUseCase.getDetail(id, callId)
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

    @PostMapping("/{id}/calls/copy")
    public ResponseEntity<CopyCallsResult> copyCalls(@PathVariable String id, @Valid @RequestBody CopyCallsRequestDto request) {
        return copyCallsToCycleUseCase.copyInto(id, request.calls())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
