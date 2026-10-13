package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * /alfred-live's work on a card, as it happens (docs/board.md "Live answers"): the runner PUTs each step and the reply
 * being written, the board shows them on the card and the live strip, and the user's Stop is handed back on the
 * runner's next report. In memory only.
 */
@RestController
public class LiveWorkController {

    private final LiveWorkUseCase work;

    public LiveWorkController(LiveWorkUseCase work) {
        this.work = work;
    }

    @GetMapping("/board/live-work")
    public ResponseEntity<?> current(@RequestParam(required = false) String project) {
        return ResponseEntity.ok(work.current(project));
    }

    @PutMapping("/board/live-work")
    public ResponseEntity<?> report(@Valid @RequestBody LiveWorkRequestDto body) {
        return ResponseEntity.ok(work.report(new LiveWorkUseCase.Report(body.id(), body.project(), body.cardNumber(), body.head(),
                body.steps(), body.draft(), body.state(), body.outcome())));
    }

    @GetMapping("/board/live-runner")
    public ResponseEntity<?> runner(@RequestParam(defaultValue = "") String project) {
        return work.runner(project).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PutMapping("/board/live-runner")
    public ResponseEntity<?> beat(@Valid @RequestBody LiveRunnerRequestDto body) {
        return ResponseEntity.ok(work.beat(body.project(), body.host(), body.model(), body.stopped()));
    }

    @PostMapping("/board/live-work/{id}/stop")
    public ResponseEntity<?> stop(@PathVariable String id) {
        return work.stop(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such live answer - it may have ended"));
    }

    public record LiveRunnerRequestDto(@Size(max = 100) String project, @Size(max = 200) String host, @Size(max = 100) String model,
                                       boolean stopped) {
    }

    public record LiveWorkRequestDto(@NotBlank @Size(max = 100) String id, @Size(max = 100) String project, @Min(1) @Max(10_000_000) int cardNumber,
                                     @Size(max = 200) String head, @Size(max = 100) List<@Size(max = 2000) String> steps,
                                     @Size(max = 64 * 1024) String draft, LiveWork.State state, @Size(max = 500) String outcome) {
    }
}
