package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Skills run from the board with ▶ (docs/board.md "Run from the board"): the board queues a run for the chat that
 * handles its cycle, that chat's runner claims it - waiting for one without polling - and hands it to the chat, which
 * takes and ends it through the MCP tools board_run_take / board_run_end. Every write goes through the board's edit
 * rule (BoardEditAccessInterceptor), so the tunnel can only copy.
 */
@RestController
public class SkillRunsController {

    static final int MAX_WAIT_SECONDS = 50;

    private final SkillRunsUseCase runs;

    public SkillRunsController(SkillRunsUseCase runs) {
        this.runs = runs;
    }

    @PostMapping("/board/skill-runs")
    public ResponseEntity<?> request(@Valid @RequestBody RunRequestDto body) {
        SkillRunsUseCase.Outcome out = runs.request(new SkillRunsUseCase.Request(body.project(), body.cycleId(), body.cardNumber(), body.command(),
                body.prompt(), body.note(), body.model(), body.host(), Boolean.TRUE.equals(body.autoRetry())));
        if (out.run() != null) {
            return ResponseEntity.status(HttpStatus.CREATED).body(out.run());
        }
        CardChange.Outcome refusal = switch (out.error()) {
            case "not-found" -> CardChange.Outcome.NOT_FOUND;
            case "conflict" -> CardChange.Outcome.CONFLICT;
            default -> CardChange.Outcome.INVALID;
        };
        return BoardWeb.refused(refusal, out.message());
    }

    @GetMapping("/board/skill-runs")
    public ResponseEntity<?> list(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) Integer cardNumber,
                                  @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(runs.list(project, cardNumber, limit));
    }

    /**
     * The runner takes the runs it may run now - or, with {@code waitSeconds}, waits (at most 50 s) until one is queued.
     * Woken by the request itself, never by polling.
     */
    @PostMapping("/board/skill-runs/claim")
    public DeferredResult<ResponseEntity<?>> claim(@Valid @RequestBody ClaimDto body) {
        int seconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, body.waitSeconds() == null ? 0 : body.waitSeconds()));
        int max = body.max() == null ? 1 : body.max();
        DeferredResult<ResponseEntity<?>> result = new DeferredResult<>(Math.max(1, seconds) * 1000L);
        List<SkillRun> now = runs.claim(body.chatId(), body.host(), max);
        if (!now.isEmpty() || seconds == 0) {
            result.setResult(ResponseEntity.ok(now));
            return result;
        }
        AtomicReference<AutoCloseable> handle = new AtomicReference<>();
        AtomicBoolean done = new AtomicBoolean();
        Runnable check = new Runnable() {
            @Override
            public void run() {
                // Off the requester's thread; subscribe before claiming so a run queued in between wakes us again.
                CompletableFuture.runAsync(() -> {
                    if (done.get()) {
                        return;
                    }
                    handle.set(runs.onQueued(this));
                    List<SkillRun> taken = runs.claim(body.chatId(), body.host(), max);
                    if (!taken.isEmpty()) {
                        if (done.compareAndSet(false, true)) {
                            close(handle.get());
                            result.setResult(ResponseEntity.ok(taken));
                        } else {
                            // the wait ended meanwhile: hand them back to the queue for the next claim
                            taken.forEach(r -> runs.report(r.id(), new SkillRunsUseCase.Report(SkillRun.State.QUEUED, r.steps(), null, null, null, null)));
                        }
                    }
                });
            }
        };
        result.onTimeout(() -> {
            if (done.compareAndSet(false, true)) {
                result.setResult(ResponseEntity.ok(List.of()));
            }
        });
        result.onCompletion(() -> {
            done.set(true);
            close(handle.get());
        });
        handle.set(runs.onQueued(check));
        return result;
    }

    @PutMapping("/board/skill-runs/{id}")
    public ResponseEntity<?> report(@PathVariable String id, @Valid @RequestBody ReportDto body) {
        return runs.report(id, new SkillRunsUseCase.Report(body.state(), body.steps(), body.outcome(), body.failure(), body.retryAt(), body.result()))
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such run"));
    }

    @PostMapping("/board/skill-runs/{id}/stop")
    public ResponseEntity<?> stop(@PathVariable String id) {
        return runs.stop(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such run"));
    }

    @PostMapping("/board/skill-runs/stop-all")
    public ResponseEntity<?> stopAll(@RequestBody(required = false) Map<String, String> body) {
        String project = body == null ? "" : body.getOrDefault("project", "");
        return ResponseEntity.ok(Map.of("stopped", runs.stopAll(project)));
    }

    private static void close(AutoCloseable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
                // nothing to release
            }
        }
    }

    public record RunRequestDto(@Size(max = 100) String project, @Size(max = 100) String cycleId, @Min(0) @Max(10_000_000) Integer cardNumber,
                                @Size(max = 300) String command, @Size(max = 16 * 1024) String prompt, @Size(max = 2000) String note,
                                @Size(max = 100) String model, @Size(max = 200) String host, Boolean autoRetry) {
    }

    public record ClaimDto(@Size(max = 100) String chatId, @Size(max = 200) String host, @Min(0) @Max(20) Integer max,
                           @Min(0) @Max(MAX_WAIT_SECONDS) Integer waitSeconds) {
    }

    /** Steps and the outcome are cut to the service's bounds rather than refused: a long run's report must still land. */
    public record ReportDto(SkillRun.State state, @Size(max = 200) List<@Size(max = 2000) String> steps, @Size(max = 2000) String outcome,
                            @Size(max = 40) String failure, Instant retryAt, @Size(max = 200) String result) {
    }
}
