package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.MarkRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.MergeRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.ProposalRequestDto;
import com.fathy.alfred.backend.board.application.port.in.BoardChangesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.application.port.in.NextStepsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CardLinksUseCase;
import com.fathy.alfred.backend.board.application.port.in.RegressionsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SessionLogUseCase;
import com.fathy.alfred.backend.board.application.port.in.TestStepsUseCase;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.CardNumberRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.SessionLogRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.SpecItemRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.StepRequestDto;
import com.fathy.alfred.backend.board.application.port.in.ProposeUseCase;
import com.fathy.alfred.backend.board.application.port.in.SearchCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SuggestMarkUseCase;
import com.fathy.alfred.backend.board.application.port.in.VerifyFixesUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

/**
 * What Claude reads and proposes across boards (docs/board.md "Claude"): search over every board, similar cards, the
 * changes after a cursor and a wait for the next one, the Fixed cards checked against a re-test cycle, proposals on a
 * card and suggested checklist marks - both waiting for the user to accept or dismiss.
 */
@RestController
public class BoardInsightsController {

    private static final String ACTOR = BoardWeb.ACTOR_HEADER;
    /** Under the gateway's 60 s proxy read timeout, so a wait always answers before nginx gives up on it. */
    static final int MAX_WAIT_SECONDS = 50;

    private final SearchCardsUseCase search;
    private final BoardChangesUseCase changes;
    private final VerifyFixesUseCase verify;
    private final ProposeUseCase proposals;
    private final SuggestMarkUseCase suggestions;
    private final NextStepsUseCase nextSteps;
    private final CardLinksUseCase cardLinks;
    private final SessionLogUseCase sessionLog;
    private final TestStepsUseCase testSteps;
    private final RegressionsUseCase regressions;

    public BoardInsightsController(SearchCardsUseCase search, BoardChangesUseCase changes, VerifyFixesUseCase verify,
                                   ProposeUseCase proposals, SuggestMarkUseCase suggestions, NextStepsUseCase nextSteps,
                                   CardLinksUseCase cardLinks, SessionLogUseCase sessionLog, TestStepsUseCase testSteps,
                                   RegressionsUseCase regressions) {
        this.nextSteps = nextSteps;
        this.cardLinks = cardLinks;
        this.sessionLog = sessionLog;
        this.testSteps = testSteps;
        this.regressions = regressions;
        this.search = search;
        this.changes = changes;
        this.verify = verify;
        this.proposals = proposals;
        this.suggestions = suggestions;
    }

    // ----------------------------------------------------------------------------------------------------------- search

    @GetMapping("/board/search")
    public ResponseEntity<?> search(@RequestParam(required = false) String project, @RequestParam(required = false) String cycleId,
                                    @RequestParam(required = false) List<String> kind, @RequestParam(required = false) List<String> status,
                                    @RequestParam(required = false) List<String> flag, @RequestParam(required = false) String author,
                                    @RequestParam(required = false) String q, @RequestParam(required = false) String since,
                                    @RequestParam(defaultValue = "false") boolean claudeTouched,
                                    @RequestParam(defaultValue = "0") int offset, @RequestParam(defaultValue = "100") int limit,
                                    @RequestParam(required = false) String waiting, @RequestParam(required = false) List<String> team) {
        try {
            // No project: every board.
            CardQuery query = new CardQuery(project == null ? "" : project, blankToNull(cycleId), enums(kind, CardKind::valueOf, CardKind.class),
                    enums(status, CardStatus::valueOf, CardStatus.class), enums(flag, Flag::valueOf, Flag.class), actor(author), false, q,
                    offset, limit, project == null, instant(since), claudeTouched,
                    waiting == null || waiting.isBlank() ? null : com.fathy.alfred.backend.board.domain.model.Waiting.valueOf(waiting.strip().toUpperCase(Locale.ROOT)),
                    false, team == null ? java.util.Set.of() : java.util.Set.copyOf(team));
            return ResponseEntity.ok(search.search(query));
        } catch (IllegalArgumentException | DateTimeParseException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Unknown filter value: " + e.getMessage());
        }
    }

    @GetMapping("/board/similar")
    public ResponseEntity<?> similar(@RequestParam(required = false) String project, @RequestParam(required = false) String title,
                                     @RequestParam(required = false) String call, @RequestParam(defaultValue = "10") int limit) {
        MentionRef ref = call == null || call.isBlank() ? null : new MentionRef(MentionType.CALL, call.strip(), "call");
        if ((title == null || title.isBlank()) && ref == null) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Give a title, a call (in:<id>, out:<id>, ...@<cycle>) or both");
        }
        return ResponseEntity.ok(search.similar(project, title, ref, limit));
    }

    // ---------------------------------------------------------------------------------------------------------- changes

    @GetMapping("/board/changes")
    public ResponseEntity<?> changes(@RequestParam(required = false) String cursor, @RequestParam(required = false) String project,
                                     @RequestParam(required = false) String cycleId, @RequestParam(required = false) String actor,
                                     @RequestParam(defaultValue = "200") int limit) {
        try {
            return ResponseEntity.ok(changes.changes(cursor, project, blankToNull(cycleId), actor(actor), limit));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, e.getMessage());
        }
    }

    /**
     * The changes after {@code cursor}, as soon as there are any - or none after {@code timeoutSeconds} (at most 50).
     * Woken by the board's change signal (the one /ws/board sends), never by polling.
     */
    @GetMapping("/board/changes/wait")
    public DeferredResult<ResponseEntity<?>> waitForChanges(@RequestParam(required = false) String cursor,
                                                            @RequestParam(required = false) String project,
                                                            @RequestParam(required = false) String cycleId,
                                                            @RequestParam(required = false) String actor,
                                                            @RequestParam(defaultValue = "200") int limit,
                                                            @RequestParam(defaultValue = "45") int timeoutSeconds) {
        int seconds = Math.max(1, Math.min(MAX_WAIT_SECONDS, timeoutSeconds));
        DeferredResult<ResponseEntity<?>> result = new DeferredResult<>(seconds * 1000L);
        Actor who;
        BoardChanges first;
        try {
            who = actor(actor);
            first = changes.changes(cursor, project, blankToNull(cycleId), who, limit);
        } catch (IllegalArgumentException e) {
            result.setResult(BoardWeb.refused(CardChange.Outcome.INVALID, e.getMessage()));
            return result;
        }
        if (!first.isEmpty()) {
            result.setResult(ResponseEntity.ok(first));
            return result;
        }
        String at = first.cursor();
        String cycle = blankToNull(cycleId);
        AtomicReference<AutoCloseable> handle = new AtomicReference<>();
        AtomicBoolean done = new AtomicBoolean();
        Runnable check = new Runnable() {
            @Override
            public void run() {
                // Off the writer's thread: the change that woke us is still being answered to its own caller. Subscribe
                // before reading, so a change in between wakes us again instead of being missed.
                CompletableFuture.runAsync(() -> {
                    if (done.get()) {
                        return;
                    }
                    handle.set(changes.onNextChange(this));
                    BoardChanges now = changes.changes(at, project, cycle, who, limit);
                    if (!now.isEmpty() && done.compareAndSet(false, true)) {
                        close(handle.get());
                        result.setResult(ResponseEntity.ok(now));
                    }
                });
            }
        };
        result.onTimeout(() -> {
            if (done.compareAndSet(false, true)) {
                result.setResult(ResponseEntity.ok(new BoardChanges(List.of(), List.of(), at, false)));
            }
        });
        result.onCompletion(() -> {
            done.set(true);
            close(handle.get());
        });
        check.run();
        return result;
    }

    /** What one board waits on: the next-step bar and /alfred-status. */
    @GetMapping("/board/next-steps")
    public ResponseEntity<?> nextSteps(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String cycleId) {
        return ResponseEntity.ok(nextSteps.nextSteps(project, blankToNull(cycleId)));
    }

    // ------------------------------------------------------------------------------------------------------- fix check

    @GetMapping("/board/verify")
    public ResponseEntity<?> verify(@RequestParam(defaultValue = "") String project, @RequestParam String cycleId) {
        return ResponseEntity.ok(verify.verify(project, cycleId.strip()));
    }

    // ------------------------------------------------------------------------------------------------------- proposals

    @PutMapping("/board/cards/{id}/proposal")
    public ResponseEntity<?> propose(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                     @Valid @RequestBody ProposalRequestDto body) {
        String kind = body.kind() == null ? "STATUS" : body.kind().strip().toUpperCase(Locale.ROOT);
        CardChange change = switch (kind) {
            case "MERGE" -> body.intoNumber() == null ? CardChange.refused(CardChange.Outcome.INVALID, "A merge needs intoNumber")
                    : proposals.proposeMerge(BoardWeb.actor(actor), id, body.intoNumber(), body.reason(), body.evidence());
            case "REOPEN" -> proposals.proposeReopen(BoardWeb.actor(actor), id, body.reason(), body.evidence());
            case "STATUS" -> proposals.propose(BoardWeb.actor(actor), id, body.status(), body.resolution(), body.reason(), body.evidence());
            default -> CardChange.refused(CardChange.Outcome.INVALID, "kind is STATUS, MERGE or REOPEN");
        };
        return BoardWeb.respond(change, HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/proposal/accept")
    public ResponseEntity<?> accept(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        return BoardWeb.respond(proposals.acceptProposal(BoardWeb.actor(actor), id), HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/merge")
    public ResponseEntity<?> merge(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                   @Valid @RequestBody MergeRequestDto body) {
        CardChange change = body.intoNumber() == null ? CardChange.refused(CardChange.Outcome.INVALID, "A merge needs intoNumber")
                : proposals.merge(BoardWeb.actor(actor), id, body.intoNumber(), body.reason());
        return BoardWeb.respond(change, HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}/proposal")
    public ResponseEntity<?> dismiss(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        return BoardWeb.respond(proposals.dismissProposal(BoardWeb.actor(actor), id), HttpStatus.OK);
    }

    // ---------------------------------------------------------------------------------- blocked by, spec items, regressions

    @PostMapping("/board/cards/{id}/blocked-by")
    public ResponseEntity<?> block(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                   @Valid @RequestBody CardNumberRequestDto body) {
        return BoardWeb.respond(cardLinks.block(BoardWeb.actor(actor), id, body.number()), HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}/blocked-by/{number}")
    public ResponseEntity<?> unblock(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                     @PathVariable int number) {
        return BoardWeb.respond(cardLinks.unblock(BoardWeb.actor(actor), id, number), HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/spec-items")
    public ResponseEntity<?> linkSpecItem(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                          @Valid @RequestBody SpecItemRequestDto body) {
        return BoardWeb.respond(cardLinks.linkSpecItem(BoardWeb.actor(actor), id, body.cycleId(), body.fileName(), body.itemKey()), HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}/spec-items")
    public ResponseEntity<?> unlinkSpecItem(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                            @Valid @RequestBody SpecItemRequestDto body) {
        return BoardWeb.respond(cardLinks.unlinkSpecItem(BoardWeb.actor(actor), id, body.cycleId(), body.fileName(), body.itemKey()), HttpStatus.OK);
    }

    @GetMapping("/board/regressions")
    public ResponseEntity<?> regressions(@RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(regressions.regressions(project));
    }

    // ---------------------------------------------------------------------------------------- session log, test steps

    @GetMapping("/board/cycles/{cycleId}/log")
    public ResponseEntity<?> log(@PathVariable String cycleId, @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(sessionLog.log(cycleId, limit));
    }

    @PostMapping("/board/cycles/{cycleId}/log")
    public ResponseEntity<?> appendLog(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                       @Valid @RequestBody SessionLogRequestDto body) {
        var entry = sessionLog.append(BoardWeb.actor(actor), cycleId, body.skill(), body.did(), body.found(), body.next());
        return entry == null ? BoardWeb.refused(CardChange.Outcome.INVALID, "skill, did, found and next are needed")
                : ResponseEntity.status(HttpStatus.CREATED).body(entry);
    }

    @GetMapping("/board/cycles/{cycleId}/steps")
    public ResponseEntity<?> steps(@PathVariable String cycleId) {
        return ResponseEntity.ok(testSteps.steps(cycleId));
    }

    @PutMapping("/board/cycles/{cycleId}/steps/{stepKey}")
    public ResponseEntity<?> markStep(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                      @PathVariable String stepKey, @Valid @RequestBody StepRequestDto body) {
        TestStepsUseCase.StepOutcome outcome = testSteps.mark(BoardWeb.actor(actor), cycleId, stepKey, body.state(), body.calls(),
                body.cardNumber(), body.note());
        return outcome.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(outcome.step()) : BoardWeb.refused(outcome.outcome(), outcome.message());
    }

    // ------------------------------------------------------------------------------------------------ suggested marks

    @PutMapping("/board/cycles/{cycleId}/checklist/{fileName}/{itemKey}/suggestion")
    public ResponseEntity<?> suggest(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                     @PathVariable String fileName, @PathVariable String itemKey, @Valid @RequestBody MarkRequestDto body) {
        return item(suggestions.suggest(BoardWeb.actor(actor), cycleId, fileName, itemKey, body.mark(), body.evidence()));
    }

    @PostMapping("/board/cycles/{cycleId}/checklist/{fileName}/{itemKey}/suggestion/accept")
    public ResponseEntity<?> acceptSuggestion(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                              @PathVariable String fileName, @PathVariable String itemKey) {
        return item(suggestions.acceptSuggestion(BoardWeb.actor(actor), cycleId, fileName, itemKey));
    }

    @DeleteMapping("/board/cycles/{cycleId}/checklist/{fileName}/{itemKey}/suggestion")
    public ResponseEntity<?> dismissSuggestion(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String cycleId,
                                               @PathVariable String fileName, @PathVariable String itemKey) {
        return item(suggestions.dismissSuggestion(BoardWeb.actor(actor), cycleId, fileName, itemKey));
    }

    private static ResponseEntity<?> item(MarkChecklistUseCase.MarkOutcome outcome) {
        return outcome.outcome() == CardChange.Outcome.OK ? ResponseEntity.ok(outcome.item())
                : BoardWeb.refused(outcome.outcome(), outcome.message());
    }

    // --------------------------------------------------------------------------------------------------------- helpers

    private static Actor actor(String name) {
        return name == null || name.isBlank() ? null : Actor.valueOf(name.strip().toUpperCase(Locale.ROOT));
    }

    /** ISO-8601, or epoch milliseconds. */
    private static Instant instant(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        String v = s.strip();
        return v.chars().allMatch(Character::isDigit) ? Instant.ofEpochMilli(Long.parseLong(v)) : Instant.parse(v);
    }

    private static void close(AutoCloseable handle) {
        if (handle == null) {
            return;
        }
        try {
            handle.close();
        } catch (Exception ignored) {
            // removing a listener cannot fail
        }
    }

    private static <E extends Enum<E>> Set<E> enums(List<String> values, Function<String, E> parse, Class<E> type) {
        if (values == null || values.isEmpty()) {
            return Set.of();
        }
        EnumSet<E> out = EnumSet.noneOf(type);
        values.stream().flatMap(v -> Arrays.stream(v.split(","))).map(String::strip).filter(s -> !s.isEmpty())
                .map(s -> parse.apply(s.toUpperCase(Locale.ROOT))).forEach(out::add);
        return out;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
