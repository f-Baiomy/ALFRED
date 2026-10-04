package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.application.port.in.RecordLogSessionsUseCase;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSession;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Session recordings of a source's live log (contracts/rest-api.md "Sessions"). */
@RestController
@RequestMapping("/logs/sources/{id}/sessions")
public class LogSessionsController {

    public record StartRequest(@Size(max = 120) String name, LogSession.Kind kind, @Size(max = 50) List<LogQuery.Pill> pills,
                               @Size(max = 200) String idField, @Size(max = 500) String idValue) {
    }

    public record MarkerRequest(@Size(max = 200) String text) {
    }

    public record UpdateRequest(@Size(max = 120) String name, @Size(max = 4000) String notes) {
    }

    private final RecordLogSessionsUseCase sessions;

    public LogSessionsController(RecordLogSessionsUseCase sessions) {
        this.sessions = sessions;
    }

    @GetMapping
    public List<RecordLogSessionsUseCase.SessionView> list(@PathVariable String id) {
        return sessions.sessions(id);
    }

    @GetMapping("/{sessionId}")
    public RecordLogSessionsUseCase.SessionView get(@PathVariable String id, @PathVariable String sessionId) {
        return sessions.session(id, sessionId);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public RecordLogSessionsUseCase.SessionView start(@PathVariable String id, @Valid @RequestBody StartRequest body) {
        return sessions.start(id, body.name(), body.kind(), body.pills(), body.idField(), body.idValue());
    }

    @PostMapping("/{sessionId}/markers")
    public RecordLogSessionsUseCase.SessionView mark(@PathVariable String id, @PathVariable String sessionId,
                                                    @Valid @RequestBody MarkerRequest body) {
        return sessions.mark(id, sessionId, body.text());
    }

    @PostMapping("/{sessionId}/stop")
    public RecordLogSessionsUseCase.SessionView stop(@PathVariable String id, @PathVariable String sessionId) {
        return sessions.stop(id, sessionId);
    }

    @PatchMapping("/{sessionId}")
    public RecordLogSessionsUseCase.SessionView update(@PathVariable String id, @PathVariable String sessionId,
                                                      @Valid @RequestBody UpdateRequest body) {
        return sessions.update(id, sessionId, body.name(), body.notes());
    }

    @DeleteMapping("/{sessionId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id, @PathVariable String sessionId) {
        sessions.delete(id, sessionId);
    }
}
