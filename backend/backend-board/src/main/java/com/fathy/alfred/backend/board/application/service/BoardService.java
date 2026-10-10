package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import com.fathy.alfred.backend.board.application.port.in.ListMentionedCallIdsUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ProposeUseCase;
import com.fathy.alfred.backend.board.application.port.in.QueryCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuickAddCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ReopenCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.SetReasonUseCase;
import com.fathy.alfred.backend.board.application.port.in.UndoCloseUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CallSignaturePort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.QuickAddParser;
import com.fathy.alfred.backend.board.domain.Transitions;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardSummary;
import com.fathy.alfred.backend.board.domain.model.CardsPage;
import com.fathy.alfred.backend.board.domain.model.ClosedReason;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.Proposal;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import com.fathy.alfred.backend.board.domain.model.SimilarClosed;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * The board's cards (specs/014-task-board). Every change writes one activity entry per changed field and sends one
 * "board changed" signal; mentions are re-indexed from text on every save; Claude's limits (ClaudeRules) are applied
 * here, whatever the caller offers.
 */
@Service
public class BoardService implements CreateCardUseCase, QuickAddCardUseCase, UpdateCardUseCase, MoveCardUseCase, DeleteCardUseCase,
        QueryCardsUseCase, GetCardUseCase, CloseCardUseCase, ReopenCardUseCase, SetReasonUseCase, UndoCloseUseCase, BulkCardsUseCase,
        LinkCardUseCase, CommentOnCardUseCase, ListActivityUseCase, ListClosedReasonsUseCase, CallBadgesUseCase,
        ListMentionedCallIdsUseCase, ProposeUseCase {

    public static final int MAX_TITLE = 300;
    public static final int MAX_TEXT = 256 * 1024;
    public static final int MAX_REASON = 2000;
    /** How long after a close Undo still works. The toast shows for 6 s; this leaves room for a slow click. */
    static final Duration UNDO_WINDOW = Duration.ofSeconds(60);
    private static final int CHIPS_PER_CARD = 3;
    private static final Set<Resolution> DISMISSED = EnumSet.of(Resolution.FINE, Resolution.NOT_IN_FLOW);

    private final BoardStorePort store;
    private final BoardNotificationPort notifications;
    private final CallSignaturePort signatures;
    private final MentionedCallsChangedPort mentionedCalls;
    private final AgentStatusUseCase agent;
    private final Clock clock;
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    public BoardService(BoardStorePort store, BoardNotificationPort notifications, CallSignaturePort signatures,
                        MentionedCallsChangedPort mentionedCalls, AgentStatusUseCase agent, BoardChangeFeed feed) {
        this(store, notifications, signatures, mentionedCalls, agent, feed, Clock.systemUTC());
    }

    BoardService(BoardStorePort store, BoardNotificationPort notifications, CallSignaturePort signatures,
                 MentionedCallsChangedPort mentionedCalls, AgentStatusUseCase agent, BoardChangeFeed feed, Clock clock) {
        this.store = store;
        this.notifications = feed.feeding(notifications);
        this.signatures = signatures;
        this.mentionedCalls = mentionedCalls;
        this.agent = agent;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------------------- create

    @Override
    public synchronized CardChange create(Actor actor, NewCard in) {
        String problem = checkTitle(in.title());
        if (problem == null) {
            problem = checkText(in.description(), "description");
        }
        if (problem == null && in.kind() == null) {
            problem = "kind is required";
        }
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        String project = in.project() == null ? "" : in.project().strip();
        String description = in.description() == null ? "" : in.description();
        List<MentionRef> links = in.links() == null ? List.of() : in.links();
        CardStatus status = in.status() == null || in.status() == CardStatus.CLOSED ? CardStatus.INBOX : in.status();
        if (actor == Actor.CLAUDE) {
            status = CardStatus.INBOX;
            if (agent.paused(project)) {
                return CardChange.refused(CardChange.Outcome.PAUSED, "The board is paused - Claude adds no cards until the user resumes");
            }
        }
        List<MentionRef> all = new ArrayList<>(MentionParser.mentions(description));
        all.addAll(links);
        String signature = signatureOf(all);
        if (actor == Actor.CLAUDE && signature != null) {
            SimilarClosed same = store.closedBySignature(project, List.of(signature)).get(signature);
            if (same != null && DISMISSED.contains(same.resolution())) {
                return CardChange.refused(CardChange.Outcome.DUPLICATE_OF_CLOSED, "Same as #" + same.number() + " \"" + same.title()
                        + "\", closed as " + resolutionName(same.resolution())
                        + (same.reason() == null || same.reason().isBlank() ? "" : ": " + same.reason()));
            }
        }
        Instant now = clock.instant();
        Card card = new Card(UUID.randomUUID().toString(), project, store.nextNumber(project), in.kind(), in.title().strip(), description,
                status, null, null, in.flags(), Scope.NOT_DECIDED, actor, blankToNull(in.cycleId()), false, signature, now, now, actor);
        store.insert(card);
        record(card.id(), actor, ActivityKind.CREATED, null, null, status.name());
        store.replaceMentions(MentionOwner.CARD, card.id(), card.id(), MentionParser.mentions(description));
        for (MentionRef link : links) {
            store.addDirect(card.id(), link);
        }
        if (anyLiveCall(all)) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(card, "card");
        return CardChange.ok(detail(card));
    }

    @Override
    public CardChange quickAdd(Actor actor, String project, String cycleId, String line) {
        QuickAddParser.Parsed parsed = QuickAddParser.parse(line);
        if (parsed.title() == null) {
            return CardChange.refused(CardChange.Outcome.INVALID, "Nothing to add - write a title after the prefix");
        }
        return create(actor, new NewCard(project, parsed.kind(), parsed.title(), "", parsed.flags(), cycleId, CardStatus.INBOX, List.of()));
    }

    // ---------------------------------------------------------------------------------------------------------- update

    @Override
    public synchronized CardChange update(Actor actor, String id, CardEdit edit) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        if (actor == Actor.CLAUDE && edit.scope() != null && edit.scope() != card.scope()) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        if (actor == Actor.CLAUDE && !ClaudeRules.mayEdit(card) && editsText(card, edit)) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.OWN_INBOX_ONLY);
        }
        if (edit.title() != null) {
            String problem = checkTitle(edit.title());
            if (problem != null) {
                return CardChange.refused(CardChange.Outcome.INVALID, problem);
            }
        }
        String problem = checkText(edit.description(), "description");
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        String title = edit.title() == null ? card.title() : edit.title().strip();
        String description = edit.description() == null ? card.description() : edit.description();
        var kind = edit.kind() == null ? card.kind() : edit.kind();
        Set<Flag> flags = edit.flags() == null ? card.flags() : edit.flags();
        Scope scope = edit.scope() == null ? card.scope() : edit.scope();
        String cycleId = edit.cycleId() == null ? card.cycleId() : blankToNull(edit.cycleId());
        String project = edit.project() == null ? card.project() : edit.project().strip();
        Instant now = clock.instant();
        Card next = card.withFields(title, description, kind, flags, scope, cycleId, project, now, actor);
        if (!project.equals(card.project())) {
            next = next.withNumber(store.nextNumber(project));
        }
        List<String[]> changes = new ArrayList<>();
        diff(changes, ActivityKind.TITLE, card.title(), title);
        if (!card.description().equals(description)) {
            changes.add(new String[]{ActivityKind.DESCRIPTION.name(), null, null});
        }
        diff(changes, ActivityKind.KIND, card.kind().name(), kind.name());
        diff(changes, ActivityKind.FLAGS, flagsText(card.flags()), flagsText(flags));
        diff(changes, ActivityKind.SCOPE, card.scope().name(), scope.name());
        diff(changes, ActivityKind.CYCLE, card.cycleId(), cycleId);
        diff(changes, ActivityKind.PROJECT, card.project(), project);
        if (changes.isEmpty()) {
            return CardChange.ok(detail(card));
        }
        List<MentionRef> before = MentionParser.mentions(card.description());
        List<MentionRef> after = MentionParser.mentions(description);
        if (next.signature() == null) {
            next = next.withSignature(signatureOf(after));
        }
        store.update(next);
        for (String[] c : changes) {
            record(id, actor, ActivityKind.valueOf(c[0]), null, c[1], c[2]);
        }
        if (!before.equals(after)) {
            store.replaceMentions(MentionOwner.CARD, id, id, after);
            if (!liveCalls(before).equals(liveCalls(after))) {
                mentionedCalls.mentionedCallsChanged();
            }
        }
        changed(next, "card");
        if (!project.equals(card.project())) {
            notifications.changed(card.project(), card.cycleId(), id, "card");
        }
        return CardChange.ok(detail(next));
    }

    // ------------------------------------------------------------------------------------------------------- statuses

    @Override
    public synchronized CardChange move(Actor actor, String id, CardStatus status) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        if (status == null || !Transitions.canMove(card.status(), status)) {
            return CardChange.refused(CardChange.Outcome.ILLEGAL_TRANSITION,
                    "Cannot move from " + card.status() + " to " + status + (status == CardStatus.CLOSED ? " - close it instead" : ""));
        }
        if (actor == Actor.CLAUDE && !ClaudeRules.mayMove(card.status(), status)) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Card next = moveCard(actor, card, status);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    private Card moveCard(Actor actor, Card card, CardStatus status) {
        Card next = card.withStatus(status, null, null, card.scope(), clock.instant(), actor);
        store.update(next);
        record(card.id(), actor, ActivityKind.STATUS, null, card.status().name(), status.name());
        return next;
    }

    @Override
    public synchronized CardChange close(Actor actor, String id, Resolution resolution, String reason) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        if (resolution == null || !Transitions.canClose(found.get().status())) {
            return CardChange.refused(resolution == null ? CardChange.Outcome.INVALID : CardChange.Outcome.ILLEGAL_TRANSITION,
                    resolution == null ? "resolution is required" : "Already closed");
        }
        String problem = checkReason(reason);
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        Card next = closeCard(actor, found.get(), resolution, reason);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    /** Writes STATUS, SCOPE and REASON first and RESOLUTION last: Undo restores from that last entry (see undoClose). */
    private Card closeCard(Actor actor, Card card, Resolution resolution, String reason) {
        Scope scope = resolution == Resolution.NOT_IN_FLOW ? Scope.OUT_OF_SCOPE : card.scope();
        String cleanReason = reason == null || reason.isBlank() ? null : reason.strip();
        Card next = card.withStatus(CardStatus.CLOSED, resolution, cleanReason, scope, clock.instant(), actor);
        store.update(next);
        record(card.id(), actor, ActivityKind.STATUS, null, card.status().name(), CardStatus.CLOSED.name());
        if (scope != card.scope()) {
            record(card.id(), actor, ActivityKind.SCOPE, null, card.scope().name(), scope.name());
        }
        if (cleanReason != null) {
            record(card.id(), actor, ActivityKind.REASON, null, null, cleanReason);
        }
        record(card.id(), actor, ActivityKind.RESOLUTION, null, previousState(card), resolution.name());
        return next;
    }

    @Override
    public synchronized CardChange reopen(Actor actor, String id) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        if (!Transitions.canReopen(card.status())) {
            return CardChange.refused(CardChange.Outcome.ILLEGAL_TRANSITION, "Only a closed card can be reopened");
        }
        Card next = card.withStatus(CardStatus.INBOX, null, null, card.scope(), clock.instant(), actor);
        store.update(next);
        record(id, actor, ActivityKind.REOPENED, null, card.resolution().name(), CardStatus.INBOX.name());
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange setReason(Actor actor, String id, String reason) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        if (card.status() != CardStatus.CLOSED) {
            return CardChange.refused(CardChange.Outcome.ILLEGAL_TRANSITION, "Only a closed card has a reason");
        }
        String problem = checkReason(reason);
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        String clean = reason == null || reason.isBlank() ? null : reason.strip();
        Card next = card.withReason(clean, clock.instant(), actor);
        store.update(next);
        record(id, actor, ActivityKind.REASON, null, card.reason(), clean);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange undoClose(Actor actor, String id) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        Optional<ActivityEntry> close = store.lastOf(id, ActivityKind.RESOLUTION.name());
        if (card.status() != CardStatus.CLOSED || close.isEmpty()) {
            return CardChange.refused(CardChange.Outcome.CONFLICT, "Nothing to undo");
        }
        if (close.get().at().plus(UNDO_WINDOW).isBefore(clock.instant())) {
            return CardChange.refused(CardChange.Outcome.CONFLICT, "Too late to undo - reopen the card instead");
        }
        boolean touched = store.after(id, close.get().id()).stream().anyMatch(e -> e.kind() != ActivityKind.REASON);
        if (touched) {
            return CardChange.refused(CardChange.Outcome.CONFLICT, "The card changed since it was closed - reopen it instead");
        }
        Map<String, String> previous = readState(close.get().oldValue());
        CardStatus status = CardStatus.valueOf(previous.getOrDefault("status", CardStatus.INBOX.name()));
        Scope scope = Scope.valueOf(previous.getOrDefault("scope", card.scope().name()));
        Card next = card.withStatus(status, null, previous.get("reason"), scope, clock.instant(), actor);
        store.update(next);
        record(id, actor, ActivityKind.STATUS, "Undo close", CardStatus.CLOSED.name(), status.name());
        if (scope != card.scope()) {
            record(id, actor, ActivityKind.SCOPE, null, card.scope().name(), scope.name());
        }
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized BulkOutcome bulk(Actor actor, List<String> ids, Action action, String reason) {
        if (actor == Actor.CLAUDE) {
            return new BulkOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, 0, ClaudeRules.USER_ONLY);
        }
        if (ids == null || ids.isEmpty() || ids.size() > MAX_CARDS || action == null) {
            return new BulkOutcome(CardChange.Outcome.INVALID, 0, "Select 1 to " + MAX_CARDS + " cards and an action");
        }
        String problem = checkReason(reason);
        if (problem != null) {
            return new BulkOutcome(CardChange.Outcome.INVALID, 0, problem);
        }
        int updated = 0;
        Map<String, String> projects = new LinkedHashMap<>();
        for (String id : new LinkedHashSet<>(ids)) {
            Optional<Card> found = store.find(id);
            if (found.isEmpty()) {
                continue;
            }
            Card card = found.get();
            boolean done = switch (action) {
                case FINE, NOT_IN_FLOW -> {
                    if (!card.open()) {
                        yield false;
                    }
                    closeCard(actor, card, action == Action.FINE ? Resolution.FINE : Resolution.NOT_IN_FLOW, reason);
                    yield true;
                }
                case TO_DO -> {
                    if (!Transitions.canMove(card.status(), CardStatus.TO_DO)) {
                        yield false;
                    }
                    moveCard(actor, card, CardStatus.TO_DO);
                    yield true;
                }
                case MARK_URGENT -> {
                    if (card.flags().contains(Flag.URGENT)) {
                        yield false;
                    }
                    EnumSet<Flag> flags = card.flags().isEmpty() ? EnumSet.noneOf(Flag.class) : EnumSet.copyOf(card.flags());
                    flags.add(Flag.URGENT);
                    Card next = card.withFields(card.title(), card.description(), card.kind(), flags, card.scope(), card.cycleId(),
                            card.project(), clock.instant(), actor);
                    store.update(next);
                    record(id, actor, ActivityKind.FLAGS, null, flagsText(card.flags()), flagsText(flags));
                    yield true;
                }
            };
            if (done) {
                updated++;
                projects.putIfAbsent(card.project(), card.cycleId());
            }
        }
        projects.forEach((project, cycleId) -> notifications.changed(project, null, null, "card"));
        return new BulkOutcome(CardChange.Outcome.OK, updated, null);
    }

    @Override
    public CardChange delete(Actor actor, String id) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        boolean hadLiveCalls = anyLiveCall(store.linksOf(id));
        store.delete(id);
        if (hadLiveCalls) {
            mentionedCalls.mentionedCallsChanged();
        }
        notifications.changed(found.get().project(), found.get().cycleId(), id, "deleted");
        return new CardChange(CardChange.Outcome.OK, null, null);
    }

    // ------------------------------------------------------------------------------------------------- links, comments

    @Override
    public synchronized CardChange link(Actor actor, String id, MentionRef ref) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        if (ref == null || ref.type() == null || ref.ref() == null || ref.ref().isBlank() || ref.label() == null
                || ref.label().isBlank() || ref.label().length() > MentionParser.MAX_LABEL) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A link needs a type, a ref and a label of at most "
                    + MentionParser.MAX_LABEL + " characters");
        }
        Card card = found.get();
        store.addDirect(id, ref);
        record(id, actor, ActivityKind.LINK_ADDED, null, null, MentionParser.serialize(ref));
        Card next = touched(card, actor, List.of(ref));
        if (ref.liveCallId() != null) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange unlink(Actor actor, String id, String type, String ref) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        if (!store.removeDirect(id, type, ref)) {
            return CardChange.refused(CardChange.Outcome.NOT_FOUND, "No such link");
        }
        record(id, actor, ActivityKind.LINK_REMOVED, null, type + ":" + ref, null);
        Card next = touched(found.get(), actor, List.of());
        if ("call".equals(type)) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CommentOutcome comment(Actor actor, String id, Comment comment) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return new CommentOutcome(CardChange.Outcome.NOT_FOUND, null, "No such card");
        }
        String text;
        boolean question = false;
        if (actor == Actor.CLAUDE && !blank(comment.question())) {
            text = "**Question** " + comment.question().strip();
            question = true;
        } else if (actor == Actor.CLAUDE && !blank(comment.reply())) {
            text = "**Reply** " + comment.reply().strip();
        } else if (actor == Actor.CLAUDE) {
            if (blank(comment.did()) || blank(comment.found()) || blank(comment.next())) {
                return new CommentOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.STRUCTURED_COMMENT);
            }
            text = "**Did** " + comment.did().strip() + "\n\n**Found** " + comment.found().strip() + "\n\n**Next** " + comment.next().strip()
                    + (blank(comment.impact()) ? "" : "\n\n**Impact** " + comment.impact().strip());
        } else {
            if (blank(comment.text())) {
                return new CommentOutcome(CardChange.Outcome.INVALID, null, "A comment needs text");
            }
            text = comment.text();
        }
        String problem = checkText(text, "comment");
        if (problem != null) {
            return new CommentOutcome(CardChange.Outcome.INVALID, null, problem);
        }
        long entryId = store.append(new ActivityEntry(0, id, actor, ActivityKind.COMMENT, text, null, null, clock.instant()));
        List<MentionRef> refs = MentionParser.mentions(text);
        store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(entryId), id, refs);
        Card next = touched(found.get(), actor, refs);
        if (question && !next.flags().contains(Flag.NEEDS_DECISION)) {
            // A question waits for the user: the card says so on the board.
            EnumSet<Flag> flags = next.flags().isEmpty() ? EnumSet.noneOf(Flag.class) : EnumSet.copyOf(next.flags());
            flags.add(Flag.NEEDS_DECISION);
            Card flagged = next.withFields(next.title(), next.description(), next.kind(), flags, next.scope(), next.cycleId(),
                    next.project(), clock.instant(), actor);
            store.update(flagged);
            record(id, actor, ActivityKind.FLAGS, null, flagsText(next.flags()), flagsText(flags));
            next = flagged;
        }
        if (anyLiveCall(refs)) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(next, "activity");
        ActivityEntry entry = new ActivityEntry(entryId, id, actor, ActivityKind.COMMENT, text, null, null, next.updatedAt());
        return new CommentOutcome(CardChange.Outcome.OK, entry, null);
    }

    /** A comment or link also counts as a change for "stale", and may give the card its first signature. */
    private Card touched(Card card, Actor actor, List<MentionRef> newRefs) {
        Card next = card.touched(clock.instant(), actor);
        if (next.signature() == null) {
            next = next.withSignature(signatureOf(newRefs));
        }
        store.update(next);
        return next;
    }

    // -------------------------------------------------------------------------------------------------------- proposals

    @Override
    public synchronized CardChange propose(Actor actor, String id, CardStatus status, Resolution resolution, String reason, String evidence) {
        if (actor != Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A proposal is Claude's - take the step yourself");
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        String problem = checkReason(reason);
        if (problem == null && evidence != null && evidence.length() > ProposeUseCase.MAX_EVIDENCE) {
            problem = "evidence is larger than 8 KB";
        }
        if (problem == null) {
            problem = proposalProblem(card, status, resolution);
        }
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        Proposal proposal = new Proposal(id, status, status == CardStatus.CLOSED ? resolution : null,
                reason == null ? "" : reason.strip(), evidence == null ? "" : evidence.strip(), clock.instant());
        store.putProposal(proposal);
        String text = proposal.reason() + (proposal.evidence().isEmpty() ? "" : "\n\n" + proposal.evidence());
        long entryId = store.append(new ActivityEntry(0, id, actor, ActivityKind.PROPOSED, text.isBlank() ? null : text, card.status().name(),
                proposal.target(), clock.instant()));
        List<MentionRef> refs = MentionParser.mentions(text);
        if (!refs.isEmpty()) {
            store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(entryId), id, refs);
            if (anyLiveCall(refs)) {
                mentionedCalls.mentionedCallsChanged();
            }
        }
        Card next = touched(card, actor, refs);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    /** What may be proposed: Verified once Fixed, Done once Fixed or Verified, a close with a resolution on an open card. */
    private static String proposalProblem(Card card, CardStatus status, Resolution resolution) {
        if (status == null) {
            return "status is required: VERIFIED, DONE or CLOSED";
        }
        return switch (status) {
            case VERIFIED -> card.status() == CardStatus.FIXED ? null : "Verified can be proposed for a Fixed card";
            case DONE -> card.status() == CardStatus.FIXED || card.status() == CardStatus.VERIFIED ? null
                    : "Done can be proposed for a Fixed or Verified card";
            case CLOSED -> resolution == null ? "A close needs a resolution: FINE, NOT_IN_FLOW or WONT_FIX"
                    : Transitions.canClose(card.status()) ? null : "The card is already closed";
            default -> "Claude moves to " + status + " itself - only Verified, Done and closing are proposed";
        };
    }

    @Override
    public synchronized CardChange acceptProposal(Actor actor, String id) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.PROPOSE_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Optional<Proposal> open = store.proposal(id);
        if (open.isEmpty()) {
            return CardChange.refused(CardChange.Outcome.CONFLICT, "Nothing proposed on this card");
        }
        Card card = found.get();
        Proposal proposal = open.get();
        if (proposalProblem(card, proposal.status(), proposal.resolution()) != null) {
            store.deleteProposal(id);
            changed(card, "card");
            return CardChange.refused(CardChange.Outcome.CONFLICT, "The card changed since Claude proposed this - the proposal is dropped");
        }
        store.deleteProposal(id);
        record(id, actor, ActivityKind.PROPOSAL_ACCEPTED, null, card.status().name(), proposal.target());
        Card next = proposal.status() == CardStatus.CLOSED
                ? closeCard(actor, card, proposal.resolution(), proposal.reason().isBlank() ? null : proposal.reason())
                : moveCard(actor, card, proposal.status());
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange dismissProposal(Actor actor, String id) {
        if (actor == Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.PROPOSE_ONLY);
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Optional<Proposal> open = store.proposal(id);
        if (open.isEmpty()) {
            return CardChange.refused(CardChange.Outcome.CONFLICT, "Nothing proposed on this card");
        }
        store.deleteProposal(id);
        record(id, actor, ActivityKind.PROPOSAL_DISMISSED, null, null, open.get().target());
        Card next = touched(found.get(), actor, List.of());
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    // ------------------------------------------------------------------------------------------------------------ reads

    @Override
    public CardsPage query(CardQuery query) {
        List<Card> cards = store.query(query);
        List<String> ids = cards.stream().map(Card::id).toList();
        Map<String, Integer> comments = store.commentCounts(ids);
        Map<String, List<MentionRef>> chips = store.chipsOf(ids, CHIPS_PER_CARD);
        Map<String, Proposal> proposals = store.proposals(ids);
        Map<String, Map<String, SimilarClosed>> similar = new LinkedHashMap<>();
        cards.stream().filter(c -> c.status() == CardStatus.INBOX && c.signature() != null)
                .collect(Collectors.groupingBy(Card::project, Collectors.mapping(Card::signature, Collectors.toSet())))
                .forEach((project, sigs) -> similar.put(project, store.closedBySignature(project, sigs)));
        List<CardSummary> rows = cards.stream().map(c -> new CardSummary(c, comments.getOrDefault(c.id(), 0),
                chips.getOrDefault(c.id(), List.of()),
                c.status() == CardStatus.INBOX && c.signature() != null
                        ? similar.getOrDefault(c.project(), Map.of()).get(c.signature()) : null, proposals.get(c.id()))).toList();
        return new CardsPage(rows, store.count(query), store.progress(query.project(), query.cycleId()));
    }

    @Override
    public Optional<CardDetail> get(String id) {
        return store.find(id).map(this::detail);
    }

    @Override
    public Optional<CardDetail> getByNumber(String project, int number) {
        return store.findByNumber(project == null ? "" : project, number).map(this::detail);
    }

    @Override
    public Optional<ActivityPage> activity(String id, int offset, int limit) {
        if (store.find(id).isEmpty()) {
            return Optional.empty();
        }
        int clamped = limit <= 0 ? ListActivityUseCase.MAX_LIMIT : Math.min(limit, ListActivityUseCase.MAX_LIMIT);
        return Optional.of(new ActivityPage(store.activity(id, Math.max(0, offset), clamped), store.activityCount(id)));
    }

    @Override
    public List<ClosedReason> closedReasons(String project, int limit) {
        int clamped = limit <= 0 ? ListClosedReasonsUseCase.MAX_LIMIT : Math.min(limit, ListClosedReasonsUseCase.MAX_LIMIT);
        return store.closedReasons(project == null ? "" : project, clamped);
    }

    @Override
    public Map<String, List<CallBadge>> badgesOfCycle(String cycleId) {
        return store.badgesOfCycle(cycleId);
    }

    @Override
    public Map<String, List<CallBadge>> badgesOfCalls(Collection<String> callIds) {
        if (callIds.size() > MAX_CALL_IDS) {
            throw new IllegalArgumentException("At most " + MAX_CALL_IDS + " call ids per request");
        }
        return callIds.isEmpty() ? Map.of() : store.badgesOfCalls(callIds);
    }

    @Override
    public Set<String> mentionedLiveCallIds() {
        return store.mentionedLiveCallIds();
    }

    // ---------------------------------------------------------------------------------------------------------- helpers

    private CardDetail detail(Card card) {
        Card full = card.description().isEmpty() ? store.find(card.id()).orElse(card) : card;
        SimilarClosed similar = full.status() == CardStatus.INBOX && full.signature() != null
                ? store.closedBySignature(full.project(), List.of(full.signature())).get(full.signature()) : null;
        int comments = store.commentCounts(List.of(full.id())).getOrDefault(full.id(), 0);
        return new CardDetail(full, comments, store.linksOf(full.id()), similar, store.proposal(full.id()).orElse(null));
    }

    private void record(String cardId, Actor actor, ActivityKind kind, String text, String oldValue, String newValue) {
        store.append(new ActivityEntry(0, cardId, actor, kind, text, oldValue, newValue, clock.instant()));
    }

    private void changed(Card card, String what) {
        notifications.changed(card.project(), card.cycleId(), card.id(), what);
    }

    private String signatureOf(List<MentionRef> refs) {
        for (MentionRef ref : refs) {
            if (ref.callId() != null) {
                Optional<String> s = signatures.signatureOf(ref.direction(), ref.callId(), ref.cycleId());
                if (s.isPresent()) {
                    return s.get();
                }
            }
        }
        return null;
    }

    private static boolean anyLiveCall(List<MentionRef> refs) {
        return refs.stream().anyMatch(r -> r.liveCallId() != null);
    }

    private static Set<String> liveCalls(List<MentionRef> refs) {
        return refs.stream().map(MentionRef::liveCallId).filter(Objects::nonNull).collect(Collectors.toSet());
    }

    private String previousState(Card card) {
        Map<String, String> state = new LinkedHashMap<>();
        state.put("status", card.status().name());
        state.put("scope", card.scope().name());
        if (card.reason() != null) {
            state.put("reason", card.reason());
        }
        try {
            return json.writeValueAsString(state);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not record the state before a close", e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> readState(String text) {
        try {
            return text == null ? Map.of() : json.readValue(text, Map.class);
        } catch (JsonProcessingException e) {
            return Map.of();
        }
    }

    private static boolean editsText(Card card, CardEdit edit) {
        return edit.title() != null && !edit.title().strip().equals(card.title())
                || edit.description() != null && !edit.description().equals(card.description())
                || edit.kind() != null && edit.kind() != card.kind()
                || edit.cycleId() != null && !Objects.equals(blankToNull(edit.cycleId()), card.cycleId())
                || edit.project() != null && !edit.project().strip().equals(card.project());
    }

    private static void diff(List<String[]> changes, ActivityKind kind, String before, String after) {
        if (!Objects.equals(before, after)) {
            changes.add(new String[]{kind.name(), before, after});
        }
    }

    static String flagsText(Set<Flag> flags) {
        return flags.stream().sorted().map(Enum::name).collect(Collectors.joining(","));
    }

    static String resolutionName(Resolution r) {
        return switch (r) {
            case FINE -> "Fine - not an issue";
            case NOT_IN_FLOW -> "Not in this flow";
            case WONT_FIX -> "Won't fix";
        };
    }

    private static String checkTitle(String title) {
        if (title == null || title.isBlank()) {
            return "title is required";
        }
        return title.strip().length() > MAX_TITLE ? "title is longer than " + MAX_TITLE + " characters" : null;
    }

    private static String checkText(String text, String what) {
        return text != null && text.length() > MAX_TEXT ? what + " is larger than " + (MAX_TEXT / 1024) + " KB" : null;
    }

    private static String checkReason(String reason) {
        return reason != null && reason.length() > MAX_REASON ? "reason is longer than " + MAX_REASON + " characters" : null;
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }
}
