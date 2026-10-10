package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.AgentStatusRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.BulkRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.CloseCardRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.CommentRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.CreateCardRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.LinkRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.MoveCardRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.ProjectRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.QuickAddRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.ReasonRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.UnlinkRequestDto;
import com.fathy.alfred.backend.board.adapter.in.web.dto.BoardRequests.UpdateCardRequestDto;
import com.fathy.alfred.backend.board.application.port.in.AgentStatusUseCase;
import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CallBadgesUseCase;
import com.fathy.alfred.backend.board.application.port.in.CloseCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.DeleteCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.GetCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.LinkCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ListActivityUseCase;
import com.fathy.alfred.backend.board.application.port.in.ListClosedReasonsUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.QueryCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuickAddCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ReopenCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.SetReasonUseCase;
import com.fathy.alfred.backend.board.application.port.in.UndoCloseUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/** Cards, their history and links, call badges, Claude's context and the live strip (contracts/rest-api.md). */
@RestController
public class BoardController {

    private static final String ACTOR = BoardWeb.ACTOR_HEADER;

    private final CreateCardUseCase create;
    private final QuickAddCardUseCase quickAdd;
    private final UpdateCardUseCase update;
    private final MoveCardUseCase move;
    private final DeleteCardUseCase delete;
    private final QueryCardsUseCase query;
    private final GetCardUseCase get;
    private final CloseCardUseCase close;
    private final ReopenCardUseCase reopen;
    private final SetReasonUseCase reason;
    private final UndoCloseUseCase undo;
    private final BulkCardsUseCase bulk;
    private final LinkCardUseCase links;
    private final CommentOnCardUseCase comments;
    private final ListActivityUseCase activity;
    private final ListClosedReasonsUseCase closedReasons;
    private final CallBadgesUseCase badges;
    private final AgentStatusUseCase agent;

    public BoardController(CreateCardUseCase create, QuickAddCardUseCase quickAdd, UpdateCardUseCase update, MoveCardUseCase move,
                           DeleteCardUseCase delete, QueryCardsUseCase query, GetCardUseCase get, CloseCardUseCase close,
                           ReopenCardUseCase reopen, SetReasonUseCase reason, UndoCloseUseCase undo, BulkCardsUseCase bulk,
                           LinkCardUseCase links, CommentOnCardUseCase comments, ListActivityUseCase activity,
                           ListClosedReasonsUseCase closedReasons, CallBadgesUseCase badges, AgentStatusUseCase agent) {
        this.create = create;
        this.quickAdd = quickAdd;
        this.update = update;
        this.move = move;
        this.delete = delete;
        this.query = query;
        this.get = get;
        this.close = close;
        this.reopen = reopen;
        this.reason = reason;
        this.undo = undo;
        this.bulk = bulk;
        this.links = links;
        this.comments = comments;
        this.activity = activity;
        this.closedReasons = closedReasons;
        this.badges = badges;
        this.agent = agent;
    }

    // ------------------------------------------------------------------------------------------------------------ cards

    @GetMapping("/board/cards")
    public ResponseEntity<?> list(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String cycleId,
                                  @RequestParam(required = false) List<String> kind, @RequestParam(required = false) List<String> status,
                                  @RequestParam(required = false) List<String> flag, @RequestParam(required = false) String author,
                                  @RequestParam(defaultValue = "false") boolean scopeNotDecided,
                                  @RequestParam(required = false) String q, @RequestParam(defaultValue = "0") int offset,
                                  @RequestParam(defaultValue = "200") int limit) {
        try {
            CardQuery cardQuery = new CardQuery(project, blankToNull(cycleId), enums(kind, CardKind::valueOf, CardKind.class),
                    enums(status, CardStatus::valueOf, CardStatus.class), enums(flag, Flag::valueOf, Flag.class),
                    author == null || author.isBlank() ? null : Actor.valueOf(author.strip().toUpperCase(Locale.ROOT)), scopeNotDecided, q,
                    offset, limit);
            return ResponseEntity.ok(query.query(cardQuery));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, "Unknown filter value: " + e.getMessage());
        }
    }

    @GetMapping("/board/cards/{id}")
    public ResponseEntity<?> card(@PathVariable String id) {
        return get.get(id).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such card"));
    }

    @GetMapping("/board/cards/by-number/{number}")
    public ResponseEntity<?> cardByNumber(@PathVariable int number, @RequestParam(defaultValue = "") String project) {
        return get.getByNumber(project, number).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No card #" + number));
    }

    @PostMapping("/board/cards")
    public ResponseEntity<?> create(@RequestHeader(value = ACTOR, required = false) String actor,
                                    @Valid @RequestBody CreateCardRequestDto body) {
        List<MentionRef> refs = body.links() == null ? List.of()
                : body.links().stream().map(l -> BoardWeb.ref(l.type(), l.ref(), l.label())).toList();
        return BoardWeb.respond(create.create(BoardWeb.actor(actor), new CreateCardUseCase.NewCard(body.project(), body.kind(),
                body.title(), body.description(), body.flags(), body.cycleId(), body.status(), refs)), HttpStatus.CREATED);
    }

    @PostMapping("/board/cards/quick")
    public ResponseEntity<?> quick(@RequestHeader(value = ACTOR, required = false) String actor, @Valid @RequestBody QuickAddRequestDto body) {
        return BoardWeb.respond(quickAdd.quickAdd(BoardWeb.actor(actor), body.project(), body.cycleId(), body.text()), HttpStatus.CREATED);
    }

    @PatchMapping("/board/cards/{id}")
    public ResponseEntity<?> update(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                    @Valid @RequestBody UpdateCardRequestDto body) {
        return BoardWeb.respond(update.update(BoardWeb.actor(actor), id, new UpdateCardUseCase.CardEdit(body.title(), body.description(),
                body.kind(), body.flags(), body.scope(), body.cycleId(), body.project())), HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/move")
    public ResponseEntity<?> move(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                  @Valid @RequestBody MoveCardRequestDto body) {
        return BoardWeb.respond(move.move(BoardWeb.actor(actor), id, body.status()), HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}")
    public ResponseEntity<?> delete(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        return BoardWeb.respond(delete.delete(BoardWeb.actor(actor), id), HttpStatus.NO_CONTENT);
    }

    // -------------------------------------------------------------------------------------------------- Inbox sorting

    @PostMapping("/board/cards/{id}/close")
    public ResponseEntity<?> close(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                   @Valid @RequestBody CloseCardRequestDto body) {
        return BoardWeb.respond(close.close(BoardWeb.actor(actor), id, body.resolution(), body.reason()), HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/reopen")
    public ResponseEntity<?> reopen(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        return BoardWeb.respond(reopen.reopen(BoardWeb.actor(actor), id), HttpStatus.OK);
    }

    @PutMapping("/board/cards/{id}/reason")
    public ResponseEntity<?> reason(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                    @Valid @RequestBody ReasonRequestDto body) {
        return BoardWeb.respond(reason.setReason(BoardWeb.actor(actor), id, body.reason()), HttpStatus.OK);
    }

    @PostMapping("/board/cards/{id}/undo-close")
    public ResponseEntity<?> undoClose(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id) {
        return BoardWeb.respond(undo.undoClose(BoardWeb.actor(actor), id), HttpStatus.OK);
    }

    @PostMapping("/board/cards/bulk")
    public ResponseEntity<?> bulk(@RequestHeader(value = ACTOR, required = false) String actor, @Valid @RequestBody BulkRequestDto body) {
        BulkCardsUseCase.BulkOutcome outcome = bulk.bulk(BoardWeb.actor(actor), body.ids(), body.action(), body.reason());
        if (outcome.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(outcome.outcome(), outcome.message());
        }
        return ResponseEntity.ok(Map.of("updated", outcome.updated()));
    }

    // -------------------------------------------------------------------------------------------- links, history

    @PostMapping("/board/cards/{id}/links")
    public ResponseEntity<?> link(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                  @Valid @RequestBody LinkRequestDto body) {
        return BoardWeb.respond(links.link(BoardWeb.actor(actor), id, BoardWeb.ref(body.type(), body.ref(), body.label())), HttpStatus.OK);
    }

    @DeleteMapping("/board/cards/{id}/links")
    public ResponseEntity<?> unlink(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                    @Valid @RequestBody UnlinkRequestDto body) {
        return BoardWeb.respond(links.unlink(BoardWeb.actor(actor), id, body.type().strip().toLowerCase(Locale.ROOT), body.ref().strip()),
                HttpStatus.OK);
    }

    @GetMapping("/board/cards/{id}/activity")
    public ResponseEntity<?> activity(@PathVariable String id, @RequestParam(defaultValue = "0") int offset,
                                      @RequestParam(defaultValue = "1000") int limit) {
        return activity.activity(id, offset, limit).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "No such card"));
    }

    @PostMapping("/board/cards/{id}/comments")
    public ResponseEntity<?> comment(@RequestHeader(value = ACTOR, required = false) String actor, @PathVariable String id,
                                     @Valid @RequestBody CommentRequestDto body) {
        CommentOnCardUseCase.CommentOutcome outcome = comments.comment(BoardWeb.actor(actor), id,
                new CommentOnCardUseCase.Comment(body.text(), body.did(), body.found(), body.next(), body.impact()));
        if (outcome.outcome() != CardChange.Outcome.OK) {
            return BoardWeb.refused(outcome.outcome(), outcome.message());
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(outcome.entry());
    }

    // ------------------------------------------------------------------------------------------ badges, Claude context

    @GetMapping("/board/cycles/{cycleId}/call-badges")
    public ResponseEntity<?> cycleBadges(@PathVariable String cycleId) {
        return ResponseEntity.ok(badges.badgesOfCycle(cycleId));
    }

    @GetMapping("/board/call-badges")
    public ResponseEntity<?> callBadges(@RequestParam(defaultValue = "") String callIds) {
        List<String> ids = Arrays.stream(callIds.split(",")).map(String::strip).filter(s -> !s.isEmpty()).distinct().toList();
        try {
            return ResponseEntity.ok(badges.badgesOfCalls(ids));
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(CardChange.Outcome.INVALID, e.getMessage());
        }
    }

    @GetMapping("/board/closed-reasons")
    public ResponseEntity<?> closedReasons(@RequestParam(defaultValue = "") String project, @RequestParam(defaultValue = "200") int limit) {
        return ResponseEntity.ok(closedReasons.closedReasons(project, limit));
    }

    // --------------------------------------------------------------------------------------------------- live strip

    @GetMapping("/board/agent-status")
    public ResponseEntity<?> agentStatus(@RequestParam(defaultValue = "") String project) {
        return agent.status(project).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PutMapping("/board/agent-status")
    public ResponseEntity<?> putAgentStatus(@Valid @RequestBody AgentStatusRequestDto body) {
        return ResponseEntity.ok(agent.update(body.project(), blankToNull(body.cycleId()), body.state(), body.callsChecked(),
                body.cardsAdded()));
    }

    @PostMapping("/board/agent-status/{action}")
    public ResponseEntity<?> agentAction(@PathVariable String action, @Valid @RequestBody ProjectRequestDto body) {
        AgentStatus.State state = switch (action) {
            case "pause" -> AgentStatus.State.PAUSED;
            case "resume" -> AgentStatus.State.WATCHING;
            case "stop" -> AgentStatus.State.STOPPED;
            default -> null;
        };
        if (state == null) {
            return BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "Unknown action " + action);
        }
        return agent.setState(body.project(), state).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> BoardWeb.refused(CardChange.Outcome.NOT_FOUND, "Claude is not on this board"));
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
