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

    /** The runner answering the board - the live runner, else the listen runner - or only the one of {@code kind} (live or listen). */
    @GetMapping("/board/live-runner")
    public ResponseEntity<?> runner(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String kind) {
        return work.runner(project, kind).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    /**
     * A runner's heartbeat. With {@code cycleId} and {@code chatId} it also holds the cycle for its chat (docs/board.md
     * "Run from the board"): 409 when another chat handles that cycle - one chat per cycle.
     */
    @PutMapping("/board/live-runner")
    public ResponseEntity<?> beat(@Valid @RequestBody LiveRunnerRequestDto body) {
        if (body.cycleId() != null && !body.cycleId().isBlank() && body.chatId() != null && !body.chatId().isBlank()) {
            LiveWorkUseCase.ChatBeat chat = work.chatBeat(body.project(), body.cycleId().strip(), body.chatId().strip(), body.host(), body.cwd(), body.kind(),
                    body.chatAlive() == null || body.chatAlive(), body.stopped());
            if (chat.conflict()) {
                LiveWorkUseCase.CycleChat c = chat.chat();
                return BoardWeb.refused(CardChange.Outcome.CONFLICT, "This cycle already runs in a chat on " + c.host() + " (since "
                        + c.since().toString().substring(11, 16) + " UTC, " + String.join(" + ", c.kinds().stream().map(k -> "/alfred-" + k).toList())
                        + ") - one chat per cycle: stop it there first, then start here.");
            }
        }
        return ResponseEntity.ok(work.beat(body.project(), body.host(), body.model(), body.kind(), body.stopped()));
    }

    /** The chat handling a cycle (null when none) and the repo folder the project's last chat ran in. */
    @GetMapping("/board/cycle-chat")
    public ResponseEntity<?> cycleChat(@RequestParam String cycleId, @RequestParam(defaultValue = "") String project) {
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("chat", work.cycleChat(cycleId.strip()).orElse(null));
        out.put("lastCwd", work.lastCwd(project).orElse(null));
        return ResponseEntity.ok(out);
    }

    @PostMapping("/board/live-work/{id}/stop")
    public ResponseEntity<?> stop(@PathVariable String id) {
        return work.stop(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such live answer - it may have ended"));
    }

    /**
     * {@code kind}: "live" (the default) or "listen"; {@code cycleId} + {@code chatId}: the cycle this runner handles for its chat; {@code chatAlive}: the chat's process still runs.
     */
    public record LiveRunnerRequestDto(@Size(max = 100) String project, @Size(max = 200) String host, @Size(max = 100) String model,
                                       @Size(max = 20) String kind, boolean stopped, @Size(max = 100) String cycleId, @Size(max = 100) String chatId,
                                       @Size(max = 1000) String cwd, Boolean chatAlive) {
    }

    /** Steps, each step and the outcome are cut to the service's own bounds rather than refused: a long run's report must still land. */
    public record LiveWorkRequestDto(@NotBlank @Size(max = 100) String id, @Size(max = 100) String project, @Min(1) @Max(10_000_000) int cardNumber,
                                     @Size(max = 200) String head, @Size(max = 200) List<@Size(max = 2000) String> steps,
                                     @Size(max = 64 * 1024) String draft, LiveWork.State state, @Size(max = 2000) String outcome) {
    }
}
