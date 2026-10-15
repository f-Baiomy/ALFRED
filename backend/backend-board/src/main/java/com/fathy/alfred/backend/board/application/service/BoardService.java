package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.AgentStatusUseCase;
import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CardLinksUseCase;
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
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.TextVersion;
import com.fathy.alfred.backend.board.application.port.in.CommentExtrasUseCase;
import com.fathy.alfred.backend.board.domain.QuickAddParser;
import com.fathy.alfred.backend.board.domain.Transitions;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Question;
import com.fathy.alfred.backend.board.domain.model.QuestionState;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswersOutcome;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.EntryAnswers;
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
import com.fathy.alfred.backend.board.domain.model.SimilarOpen;
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.SpecItemLink;
import com.fathy.alfred.backend.board.domain.AcceptanceItems;
import com.fathy.alfred.backend.board.domain.model.Waiting;
import com.fathy.alfred.backend.board.domain.model.WaitingOn;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.fathy.alfred.backend.board.application.port.in.AssignTeamsUseCase;
import com.fathy.alfred.backend.board.domain.TeamHints;
import com.fathy.alfred.backend.board.domain.model.Team;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.Locale;
import java.util.HashMap;
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
        ListMentionedCallIdsUseCase, ProposeUseCase, CardLinksUseCase, AssignTeamsUseCase, CommentExtrasUseCase,
        com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase, com.fathy.alfred.backend.board.application.port.in.ShortNameUseCase {

    public static final int MAX_TITLE = 300;
    public static final int MAX_TEXT = 256 * 1024;
    public static final int MAX_REASON = 2000;
    /** How long after a close Undo still works. The toast shows for 6 s; this leaves room for a slow click. */
    static final Duration UNDO_WINDOW = Duration.ofSeconds(60);
    private static final int CHIPS_PER_CARD = 3;
    private static final Set<Resolution> DISMISSED = EnumSet.of(Resolution.FINE, Resolution.NOT_IN_FLOW);
    /** Words a new card's title must share with a dismissed card's for Claude to be refused it when they share no call. */
    private static final int DISMISSED_SHARED_WORDS = 2;

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
        String cleanDescription = in.description() == null ? null : RichText.clean(in.description());
        String problem = checkTitle(in.title());
        if (problem == null) {
            problem = checkText(cleanDescription, "description");
        }
        if (problem == null && in.kind() == null) {
            problem = "kind is required";
        }
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        String project = in.project() == null ? "" : in.project().strip();
        String description = cleanDescription == null ? "" : cleanDescription;
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
            if (same != null && DISMISSED.contains(same.resolution()) && repeatsDismissed(project, same, all, in.title(), in.kind(), signature)) {
                return CardChange.refused(CardChange.Outcome.DUPLICATE_OF_CLOSED, "Same as #" + same.number() + " \"" + same.title()
                        + "\", closed as " + resolutionName(same.resolution())
                        + (same.reason() == null || same.reason().isBlank() ? "" : ": " + same.reason()));
            }
        }
        // Teams: the ones asked for, or - when none - the ones whose hints the card's own words match.
        List<Team> known = store.teams();
        List<String> teams;
        String teamsReason = null;
        if (in.teams() != null && !in.teams().isEmpty()) {
            TeamPick pick = pickTeams(in.teams(), known);
            if (pick.unknown() != null) {
                return CardChange.refused(CardChange.Outcome.INVALID, pick.unknown());
            }
            teams = pick.ids();
        } else {
            List<TeamHints.Match> matches = TeamHints.match(known, in.title(), RichText.plain(description));
            teams = matches.stream().map(TeamHints.Match::teamId).toList();
            if (!matches.isEmpty()) {
                teamsReason = "From the teams' hints: " + matches.stream().map(m -> nameOf(m.teamId(), known) + " (\"" + m.hint() + "\")")
                        .collect(Collectors.joining(", "));
            }
        }
        Instant now = clock.instant();
        Card card = new Card(UUID.randomUUID().toString(), project, store.nextNumber(project), in.kind(), in.title().strip(), description,
                status, null, null, in.flags(), Scope.NOT_DECIDED, actor, blankToNull(in.cycleId()), false, signature, now, now, actor, teams);
        store.insert(card);
        record(card.id(), actor, ActivityKind.CREATED, null, null, status.name());
        if (!teams.isEmpty()) {
            record(card.id(), actor, ActivityKind.TEAMS, teamsReason, "", String.join(",", teams));
        }
        if (actor == Actor.CLAUDE) {
            waitOn(card.id(), Waiting.USER, actor); // a finding waits for the user to sort it
        }
        store.replaceMentions(MentionOwner.CARD, card.id(), card.id(), MentionParser.mentions(description));
        store.attachImages(RichText.imageIds(description), card.id(), null);
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
        String newDescription = edit.description() == null ? null : RichText.clean(edit.description());
        String problem = checkText(newDescription, "description");
        if (problem != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, problem);
        }
        String title = edit.title() == null ? card.title() : edit.title().strip();
        String description = newDescription == null ? card.description() : newDescription;
        var kind = edit.kind() == null ? card.kind() : edit.kind();
        Set<Flag> flags = edit.flags() == null ? card.flags() : edit.flags();
        if (actor == Actor.CLAUDE && card.flags().contains(Flag.NEEDS_DECISION) && !flags.contains(Flag.NEEDS_DECISION)) {
            int open = unansweredQuestions(card.id());
            if (open > 0) {
                return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, open + " question" + (open == 1 ? " is" : "s are")
                        + " still open on #" + card.number() + " - withdraw " + (open == 1 ? "it" : "them") + " (board_withdraw_question, with why) or wait for the answer");
            }
        }
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
        if (!card.description().equals(description)) {
            if (!card.description().isBlank()) {
                store.saveVersion(new TextVersion("description:" + id, card.description(), card.updatedBy(), now));
            }
            store.attachImages(RichText.imageIds(description), id, null);
        }
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

    // ---------------------------------------------------------------------------------------------------------- teams

    @Override
    public synchronized CardChange assignTeams(Actor actor, String id, List<String> wanted, String reason) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        String why = reason == null ? null : reason.strip();
        if (why != null && why.length() > MAX_REASON) {
            return CardChange.refused(CardChange.Outcome.INVALID, "reason is limited to " + MAX_REASON + " characters");
        }
        if (actor == Actor.CLAUDE && (why == null || why.isEmpty())) {
            return CardChange.refused(CardChange.Outcome.INVALID, "Say why these teams (reason) - it goes into the card's history");
        }
        TeamPick pick = pickTeams(wanted == null ? List.of() : wanted, store.teams());
        if (pick.unknown() != null) {
            return CardChange.refused(CardChange.Outcome.INVALID, pick.unknown());
        }
        Card card = found.get();
        if (card.teams().equals(pick.ids())) {
            return CardChange.ok(detail(card));
        }
        Card next = card.withTeams(pick.ids(), clock.instant(), actor);
        store.update(next);
        record(id, actor, ActivityKind.TEAMS, why == null || why.isEmpty() ? null : why, String.join(",", card.teams()),
                String.join(",", next.teams()));
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    /** Team ids for what was asked - an id or a name, any case - or the first one that is not a team. */
    private static TeamPick pickTeams(List<String> wanted, List<Team> known) {
        LinkedHashSet<String> ids = new LinkedHashSet<>();
        for (String w : wanted) {
            if (w == null || w.isBlank()) {
                continue;
            }
            String s = w.strip();
            Optional<Team> team = known.stream().filter(t -> t.id().equalsIgnoreCase(s) || t.name().equalsIgnoreCase(s)).findFirst();
            if (team.isEmpty()) {
                return new TeamPick(List.of(), "No team \"" + s + "\" - the teams are: "
                        + known.stream().map(Team::name).collect(Collectors.joining(", ")));
            }
            ids.add(team.get().id());
        }
        return new TeamPick(List.copyOf(ids), null);
    }

    private static String nameOf(String teamId, List<Team> known) {
        return known.stream().filter(t -> t.id().equals(teamId)).map(Team::name).findFirst().orElse(teamId);
    }

    private record TeamPick(List<String> ids, String unknown) {
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
        if (actor == Actor.USER && card.status() == CardStatus.INBOX && status == CardStatus.TO_DO) {
            answerBySorting(card.id(), "to do");
        }
        Card next = moveCard(actor, store.find(id).orElse(card), status);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    private Card moveCard(Actor actor, Card card, CardStatus status) {
        Card next = card.withStatus(status, null, null, card.scope(), clock.instant(), actor);
        store.update(next);
        record(card.id(), actor, ActivityKind.STATUS, null, card.status().name(), status.name());
        afterStatus(card.id(), status, actor);
        return next;
    }

    /**
     * Who a card waits on after it reached {@code status} (specs/015 FR-1): sorted to To do / In progress means Claude
     * has work, Fixed waits on a re-test, Verified / Done / closed on nobody, back in the Inbox on the user.
     */
    private void afterStatus(String cardId, CardStatus status, Actor actor) {
        Waiting who = switch (status) {
            case TO_DO, IN_PROGRESS -> Waiting.CLAUDE;
            case FIXED -> Waiting.RETEST;
            case VERIFIED, DONE, CLOSED -> Waiting.NONE;
            case INBOX -> Waiting.USER;
        };
        waitOn(cardId, who, actor);
    }

    /** Sets who the card waits on; the "since" time is kept while it does not change. */
    void waitOn(String cardId, Waiting who, Actor actor) {
        Optional<WaitingOn> now = store.waiting(cardId);
        if (now.isPresent() && now.get().who() == who) {
            return;
        }
        store.setWaiting(cardId, new WaitingOn(who, clock.instant(), actor));
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
        answerBySorting(id, switch (resolution) {
            case FINE -> "fine";
            case NOT_IN_FLOW -> "not in this flow";
            case WONT_FIX -> "won't fix";
            case DUPLICATE -> "duplicate";
        });
        Card next = closeCard(actor, store.find(id).orElse(found.get()), resolution, reason);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    /**
     * The user sorted a card with its own buttons (specs/020): an open question of Claude's that offers that choice -
     * the triage question "To do / Fine / Not in this flow" - is answered with it, so Claude hears the decision and the
     * question does not stay open on a sorted card.
     */
    private void answerBySorting(String cardId, String choice) {
        Instant now = clock.instant();
        java.util.Map<Long, java.util.Map<String, AnswerIn>> byEntry = new java.util.LinkedHashMap<>();
        for (Question q : store.questionsOf(cardId)) {
            if (!q.open(now) || q.parentIdx() != null) {
                continue;
            }
            Optional<ActivityEntry> asked = store.activityEntry(q.entryId());
            if (asked.isEmpty()) {
                continue;
            }
            QuestionBlocks.asked(asked.get().text()).stream().filter(a -> a.idx() == q.idx()).findFirst()
                    .flatMap(a -> a.options().stream().filter(o -> sameChoice(o, choice)).findFirst())
                    .ifPresent(label -> byEntry.computeIfAbsent(q.entryId(), k -> new java.util.LinkedHashMap<>())
                            .put(q.header(), new AnswerIn(List.of(label), null, "sorted on the board", null)));
        }
        if (!byEntry.isEmpty()) {
            answer(Actor.USER, cardId, byEntry.entrySet().stream().map(e -> new EntryAnswers(e.getKey(), e.getValue())).toList(), true);
        }
    }

    private static boolean sameChoice(String label, String choice) {
        String l = label.toLowerCase(Locale.ROOT).replaceAll("[^a-z' ]", " ").replaceAll("\\s+", " ").strip();
        return l.equals(choice) || l.startsWith(choice + " ") || (choice.equals("not in this flow") && l.startsWith("not in flow"));
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
        waitOn(card.id(), Waiting.NONE, actor);
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
        waitOn(id, Waiting.USER, actor);
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
        afterStatus(id, status, actor);
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
        boolean liveCallsGone = false;
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
                case DELETE -> {
                    boolean live = anyLiveCall(store.linksOf(id));
                    if (!store.delete(id)) {
                        yield false;
                    }
                    if (live) {
                        liveCallsGone = true;
                    }
                    yield true;
                }
            };
            if (done) {
                updated++;
                projects.putIfAbsent(card.project(), card.cycleId());
            }
        }
        if (liveCallsGone) {
            mentionedCalls.mentionedCallsChanged();
        }
        String what = action == Action.DELETE ? "deleted" : "card";
        projects.forEach((project, cycleId) -> notifications.changed(project, null, null, what));
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

    @Override
    public synchronized CycleCardsDeleted deleteCycleCards(Actor actor, String cycleId) {
        if (actor == Actor.CLAUDE) {
            return new CycleCardsDeleted(CardChange.Outcome.REFUSED_FOR_CLAUDE, 0, ClaudeRules.USER_ONLY);
        }
        if (cycleId == null || cycleId.isBlank()) {
            return new CycleCardsDeleted(CardChange.Outcome.INVALID, 0, "Name the cycle");
        }
        int deleted = 0;
        boolean live = false;
        Map<String, Boolean> projects = new LinkedHashMap<>();
        for (String id : store.cardIdsOfCycle(cycleId)) {
            Optional<Card> card = store.find(id);
            live |= anyLiveCall(store.linksOf(id));
            if (store.delete(id)) {
                deleted++;
                card.ifPresent(c -> projects.put(c.project(), true));
            }
        }
        if (live) {
            mentionedCalls.mentionedCallsChanged();
        }
        projects.keySet().forEach(project -> notifications.changed(project, cycleId, null, "deleted"));
        return new CycleCardsDeleted(CardChange.Outcome.OK, deleted, null);
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
        Long replyTo = null;
        if (comment.replyTo() != null) {
            Optional<ActivityEntry> parent = store.activityEntry(comment.replyTo());
            if (parent.isEmpty() || !parent.get().cardId().equals(id) || parent.get().kind() != ActivityKind.COMMENT) {
                return new CommentOutcome(CardChange.Outcome.INVALID, null, "replyTo must be a comment on this card");
            }
            // One level: a reply to a reply joins the thread of the first comment.
            replyTo = parent.get().replyTo() != null ? parent.get().replyTo() : parent.get().id();
        }
        if (actor == Actor.CLAUDE && replyTo != null && !blank(comment.reply())) {
            Optional<ActivityEntry> already = claudeAnsweredLast(id, replyTo);
            if (already.isPresent()) {
                // Two Claude runs answering one board (specs/019): the second answer to the same message is refused.
                return new CommentOutcome(CardChange.Outcome.CONFLICT, already.get(), "Already answered: Claude replied to the user's last message "
                        + "in this thread at " + already.get().at() + " - one answer per message");
            }
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
            text = RichText.clean(comment.text());
        }
        String problem = checkText(text, "comment");
        if (problem == null && question) {
            problem = QuestionBlocks.problem(text);
        }
        if (problem != null) {
            return new CommentOutcome(CardChange.Outcome.INVALID, null, problem);
        }
        if (question) {
            ensureIndexed();
            Optional<ActivityEntry> asked = sameOpenQuestion(id, QuestionBlocks.asked(text));
            if (asked.isPresent()) {
                return new CommentOutcome(CardChange.Outcome.OK, asked.get(), "Already asked: [" + asked.get().id() + "] asks the same and is still open"
                        + " - wait for the user's answer");
            }
        }
        long entryId = store.append(new ActivityEntry(0, id, actor, ActivityKind.COMMENT, text, null, null, clock.instant(), replyTo));
        boolean answersQuestion = actor == Actor.USER && replyTo != null && store.activityEntry(replyTo).map(ActivityEntry::isQuestion).orElse(false);
        if (question) {
            indexQuestions(id, entryId, text, clock.instant(), null);
        } else if (answersQuestion) {
            answeredInWords(replyTo, entryId);
        }
        List<MentionRef> refs = MentionParser.mentions(text);
        store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(entryId), id, refs);
        store.attachImages(RichText.imageIds(text), id, null);
        Card next = touched(found.get(), actor, refs);
        if (question) {
            // A question waits for the user: the card says so on the board.
            next = syncDecision(next, actor, false);
            waitOn(id, Waiting.USER, actor);
        } else if (answersQuestion) {
            // The user's answer to Claude's last open question: the card no longer waits on a decision (when they say so).
            next = syncDecision(next, actor, comment.clearDecision());
            if (unansweredQuestions(id) == 0) {
                waitOn(id, Waiting.CLAUDE, actor); // every question answered: Claude's turn
            }
        }
        if (comment.waitingOn() != null) {
            waitOn(id, comment.waitingOn(), actor);
        }
        if (anyLiveCall(refs)) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(next, "activity");
        ActivityEntry entry = new ActivityEntry(entryId, id, actor, ActivityKind.COMMENT, text, null, null, next.updatedAt(), replyTo);
        return new CommentOutcome(CardChange.Outcome.OK, entry, null);
    }

    // ------------------------------------------------------------------------------------------- reactions and edits

    @Override
    public synchronized Outcome react(Actor actor, String cardId, long commentId, String emoji) {
        if (actor != Actor.USER) {
            return new Outcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Reactions are the user's", false);
        }
        String e = emoji == null ? "" : emoji.strip();
        if (!REACTIONS.contains(e)) {
            return new Outcome(CardChange.Outcome.INVALID, "A reaction is one of " + String.join(" ", REACTIONS), false);
        }
        Optional<Card> found = store.find(cardId);
        Optional<ActivityEntry> target = store.activityEntry(commentId);
        if (found.isEmpty() || target.isEmpty() || !target.get().cardId().equals(cardId) || target.get().kind() != ActivityKind.COMMENT) {
            return new Outcome(CardChange.Outcome.NOT_FOUND, "No such comment on this card", false);
        }
        Optional<ActivityEntry> mine = store.after(cardId, commentId).stream()
                .filter(x -> x.kind() == ActivityKind.REACTION && x.actor() == actor && e.equals(x.text()) && Long.valueOf(commentId).equals(x.replyTo()))
                .findFirst();
        Card next = found.get().touched(clock.instant(), actor);
        store.update(next);
        if (mine.isPresent()) {
            store.deleteActivity(mine.get().id());
            changed(next, "activity");
            return new Outcome(CardChange.Outcome.OK, null, false);
        }
        store.append(new ActivityEntry(0, cardId, actor, ActivityKind.REACTION, e, null, null, clock.instant(), commentId));
        if (GO.equals(e) && target.get().actor() == Actor.CLAUDE) {
            waitOn(cardId, Waiting.CLAUDE, actor); // ✅ on Claude's plan or question is the go-ahead: Claude's turn
        }
        changed(next, "activity");
        return new Outcome(CardChange.Outcome.OK, null, true);
    }

    @Override
    public synchronized Outcome editComment(Actor actor, String cardId, long commentId, String text) {
        if (actor != Actor.USER) {
            return new Outcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Claude does not edit comments - it writes a new one", false);
        }
        Optional<Card> found = store.find(cardId);
        Optional<ActivityEntry> target = store.activityEntry(commentId);
        if (found.isEmpty() || target.isEmpty() || !target.get().cardId().equals(cardId) || target.get().kind() != ActivityKind.COMMENT) {
            return new Outcome(CardChange.Outcome.NOT_FOUND, "No such comment on this card", false);
        }
        if (target.get().actor() != Actor.USER) {
            return new Outcome(CardChange.Outcome.INVALID, "Only your own comments can be edited", false);
        }
        if (blank(text)) {
            return new Outcome(CardChange.Outcome.INVALID, "A comment needs text", false);
        }
        String clean = RichText.clean(text);
        String problem = checkText(clean, "comment");
        if (problem != null) {
            return new Outcome(CardChange.Outcome.INVALID, problem, false);
        }
        String before = target.get().text() == null ? "" : target.get().text();
        if (before.equals(clean)) {
            return new Outcome(CardChange.Outcome.OK, null, false);
        }
        Instant now = clock.instant();
        store.saveVersion(new TextVersion("comment:" + commentId, before, Actor.USER, now));
        store.updateActivityText(commentId, clean);
        List<MentionRef> beforeRefs = MentionParser.mentions(before);
        List<MentionRef> refs = MentionParser.mentions(clean);
        store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(commentId), cardId, refs);
        store.attachImages(RichText.imageIds(clean), cardId, null);
        // in the history and the change feed, so Claude (and /alfred-live) sees the comment changed
        store.append(new ActivityEntry(0, cardId, actor, ActivityKind.COMMENT_EDITED, clean, null, null, now, commentId));
        Card next = found.get().touched(now, actor);
        store.update(next);
        if (!liveCalls(beforeRefs).equals(liveCalls(refs))) {
            mentionedCalls.mentionedCallsChanged();
        }
        changed(next, "activity");
        return new Outcome(CardChange.Outcome.OK, null, true);
    }

    @Override
    public List<TextVersion> versions(String owner) {
        return owner == null || !owner.matches("^(comment|description):[\\w-]{1,100}$") ? List.of() : store.versions(owner);
    }

    /** Claude's questions on the card still waiting on the user (open, or put off and due again). */
    int unansweredQuestions(String cardId) {
        ensureIndexed();
        return store.openQuestionCounts(List.of(cardId), clock.instant()).getOrDefault(cardId, 0);
    }

    // ------------------------------------------------------------------------------------------------ questions (019)

    /** When the index was last brought up to date with question comments written before it, or imported. */
    private volatile Instant indexedAt;

    void ensureIndexed() {
        Instant now = clock.instant();
        if (indexedAt != null && now.isBefore(indexedAt.plusSeconds(60))) {
            return;
        }
        indexedAt = now;
        for (ActivityEntry q : store.unindexedQuestions()) {
            Optional<ActivityEntry> answer = store.after(q.cardId(), q.id()).stream()
                    .filter(e -> e.actor() == Actor.USER && e.kind() == ActivityKind.COMMENT && Long.valueOf(q.id()).equals(e.replyTo())).findFirst();
            indexQuestions(q.cardId(), q.id(), q.text(), q.at(), answer.map(ActivityEntry::id).orElse(null));
        }
    }

    /** The rows of one question comment: its questions OPEN, follow-ups PENDING - or all done when it was answered in words. */
    private void indexQuestions(String cardId, long entryId, String text, Instant at, Long answeredBy) {
        List<Question> rows = QuestionBlocks.asked(text).stream().map(a -> new Question(entryId, cardId, a.idx(), a.header(), a.question(),
                answeredBy != null ? (a.parentIdx() == null ? QuestionState.ANSWERED : QuestionState.DROPPED)
                        : a.parentIdx() == null ? QuestionState.OPEN : QuestionState.PENDING,
                null, answeredBy, a.parentIdx(), a.parentOption(), at, a.recommended())).toList();
        store.putQuestions(entryId, rows);
    }

    /** A reply in words (no options picked) answers every question of the comment still waiting; its follow-ups are dropped. */
    private void answeredInWords(long questionEntry, long answerEntry) {
        for (Question q : store.questionsOf(store.activityEntry(questionEntry).map(ActivityEntry::cardId).orElse(""))) {
            if (q.entryId() == questionEntry && !done(q)) {
                store.updateQuestion(q.with(q.parentIdx() == null ? QuestionState.ANSWERED : QuestionState.DROPPED, null, answerEntry));
            }
        }
    }

    private static boolean done(Question q) {
        return q.state() == QuestionState.ANSWERED || q.state() == QuestionState.WITHDRAWN || q.state() == QuestionState.DROPPED;
    }

    /** The same questions are already open on the card (two runs asking at once, or Claude asking again): the comment that asks them. */
    private Optional<ActivityEntry> sameOpenQuestion(String cardId, List<QuestionBlocks.Asked> asked) {
        Map<String, Long> open = new HashMap<>();
        store.questionsOf(cardId).stream().filter(q -> !done(q)).forEach(q -> open.putIfAbsent(QuestionBlocks.sameness(q.text()), q.entryId()));
        List<QuestionBlocks.Asked> top = asked.stream().filter(a -> a.parentIdx() == null).toList();
        if (top.isEmpty() || !top.stream().allMatch(a -> open.containsKey(QuestionBlocks.sameness(a.question())))) {
            return Optional.empty();
        }
        return store.activityEntry(open.get(QuestionBlocks.sameness(top.get(0).question())));
    }

    /** Claude's Reply after the user's last message in this thread - the message is answered already. */
    private Optional<ActivityEntry> claudeAnsweredLast(String cardId, long root) {
        List<ActivityEntry> thread = store.after(cardId, root - 1).stream()
                .filter(e -> e.kind() == ActivityKind.COMMENT && (e.id() == root || Long.valueOf(root).equals(e.replyTo()))).toList();
        ActivityEntry lastUser = null;
        for (ActivityEntry e : thread) {
            if (e.actor() == Actor.USER) {
                lastUser = e;
            }
        }
        if (lastUser == null) {
            return Optional.empty();
        }
        long after = lastUser.id();
        return thread.stream().filter(e -> e.id() > after && e.actor() == Actor.CLAUDE && e.text() != null && e.text().startsWith("**Reply**"))
                .findFirst();
    }

    /** Needs decision follows the open questions: on while one is open; off when none is - if this change may clear it. */
    private Card syncDecision(Card card, Actor actor, boolean mayClear) {
        boolean open = unansweredQuestions(card.id()) > 0;
        boolean flagged = card.flags().contains(Flag.NEEDS_DECISION);
        if (open == flagged || (!open && !mayClear)) {
            return card;
        }
        EnumSet<Flag> flags = card.flags().isEmpty() ? EnumSet.noneOf(Flag.class) : EnumSet.copyOf(card.flags());
        if (open) {
            flags.add(Flag.NEEDS_DECISION);
        } else {
            flags.remove(Flag.NEEDS_DECISION);
        }
        Card next = card.withFields(card.title(), card.description(), card.kind(), flags, card.scope(), card.cycleId(), card.project(),
                clock.instant(), actor);
        store.update(next);
        record(card.id(), actor, ActivityKind.FLAGS, null, flagsText(card.flags()), flagsText(flags));
        return next;
    }

    @Override
    public synchronized CardChange setShortName(Actor actor, String cardId, String shortName) {
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        String name = shortName == null ? "" : shortName.strip().replaceAll("\\s+", " ");
        if (name.length() > MAX_SHORT_NAME) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A short name is a few words - at most " + MAX_SHORT_NAME + " characters");
        }
        if (name.contains("|") || name.contains("]")) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A short name cannot hold | or ]");
        }
        if (actor == Actor.CLAUDE && store.shortNames("card", List.of(cardId)).containsKey(cardId)) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, "This card already has a short name - only the user changes it");
        }
        store.putShortName("card", cardId, name);
        Card card = found.get();
        changed(card, "card");
        return CardChange.ok(detail(card));
    }

    @Override
    public List<Question> questions(String cardId) {
        ensureIndexed();
        return store.questionsOf(cardId);
    }

    @Override
    public Map<String, Integer> openQuestionCards(String project, String cycleId) {
        ensureIndexed();
        return store.openQuestionCards(project, cycleId, clock.instant());
    }

    @Override
    public synchronized AnswersOutcome answer(Actor actor, String cardId, List<EntryAnswers> answers, boolean clearDecision) {
        if (actor != Actor.USER) {
            return new AnswersOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, List.of(), "Answers are the user's");
        }
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return new AnswersOutcome(CardChange.Outcome.NOT_FOUND, List.of(), "No such card");
        }
        if (answers == null || answers.isEmpty() || answers.stream().allMatch(a -> a.answers() == null || a.answers().isEmpty())) {
            return new AnswersOutcome(CardChange.Outcome.INVALID, List.of(), "Nothing to send - answer at least one question");
        }
        ensureIndexed();
        Instant now = clock.instant();
        List<Question> rows = store.questionsOf(cardId);
        // Everything is checked before anything is written: a batch is sent whole or not at all.
        for (EntryAnswers ea : answers) {
            Optional<ActivityEntry> entry = store.activityEntry(ea.entryId());
            if (entry.isEmpty() || !entry.get().cardId().equals(cardId) || !entry.get().isQuestion()) {
                return new AnswersOutcome(CardChange.Outcome.INVALID, List.of(), "[" + ea.entryId() + "] is not one of Claude's questions on this card");
            }
            Map<String, QuestionBlocks.Asked> asked = new HashMap<>();
            QuestionBlocks.asked(entry.get().text()).forEach(a -> asked.put(a.header(), a));
            for (Map.Entry<String, AnswerIn> a : ea.answers().entrySet()) {
                String why = problem(rows, ea, asked.get(a.getKey()), a.getKey(), a.getValue(), now);
                if (why != null) {
                    return new AnswersOutcome(CardChange.Outcome.INVALID, List.of(), why);
                }
            }
        }
        List<ActivityEntry> written = new ArrayList<>();
        for (EntryAnswers ea : answers) {
            if (ea.answers() == null || ea.answers().isEmpty()) {
                continue;
            }
            String text = QuestionBlocks.answerText(ea.answers());
            long entryId = store.append(new ActivityEntry(0, cardId, actor, ActivityKind.COMMENT, text, null, null, now, ea.entryId()));
            store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(entryId), cardId, MentionParser.mentions(text));
            written.add(new ActivityEntry(entryId, cardId, actor, ActivityKind.COMMENT, text, null, null, now, ea.entryId()));
            for (Question q : store.questionsOf(cardId)) {
                if (q.entryId() != ea.entryId()) {
                    continue;
                }
                AnswerIn a = ea.answers().get(q.header());
                if (a != null) {
                    store.updateQuestion(a.later() != null ? q.with(QuestionState.LATER, a.later(), null) : q.with(QuestionState.ANSWERED, null, entryId));
                }
            }
            // Follow-ups: open when their option was picked (and not answered in this send), dropped when another one was.
            for (Question q : store.questionsOf(cardId)) {
                if (q.entryId() != ea.entryId() || q.parentIdx() == null || q.state() != QuestionState.PENDING) {
                    continue;
                }
                Question parent = store.questionsOf(cardId).stream().filter(x -> x.entryId() == q.entryId() && x.idx() == q.parentIdx()).findFirst().orElse(null);
                AnswerIn pa = parent == null ? null : ea.answers().get(parent.header());
                if (parent == null || parent.state() != QuestionState.ANSWERED || pa == null) {
                    continue;
                }
                store.updateQuestion(q.with(pa.chose().contains(q.parentOption()) ? QuestionState.OPEN : QuestionState.DROPPED, null, null));
            }
        }
        Card next = found.get().touched(now, actor);
        store.update(next);
        next = syncDecision(next, actor, clearDecision);
        if (unansweredQuestions(cardId) == 0) {
            waitOn(cardId, Waiting.CLAUDE, actor); // every question answered: Claude's turn
        }
        changed(next, "activity");
        return new AnswersOutcome(CardChange.Outcome.OK, written, null);
    }

    /** Why one answer cannot be taken, or null. A follow-up may be answered with the answer that opens it, in the same send. */
    private static String problem(List<Question> rows, EntryAnswers ea, QuestionBlocks.Asked asked, String header, AnswerIn a, Instant now) {
        Question row = rows.stream().filter(q -> q.entryId() == ea.entryId() && q.header().equals(header)).findFirst().orElse(null);
        if (row == null || asked == null) {
            return "[" + ea.entryId() + "] has no question \"" + header + "\"";
        }
        if (done(row)) {
            return "\"" + header + "\" is " + row.state().name().toLowerCase(Locale.ROOT) + " already";
        }
        if (row.state() == QuestionState.PENDING) {
            Question parent = rows.stream().filter(q -> q.entryId() == row.entryId() && q.idx() == row.parentIdx()).findFirst().orElse(null);
            AnswerIn pa = parent == null ? null : ea.answers().get(parent.header());
            if (pa == null || !pa.chose().contains(row.parentOption())) {
                return "\"" + header + "\" follows \"" + row.parentOption() + "\" - answer it with that choice";
            }
        }
        if (a.later() != null) {
            return a.later().isAfter(now) ? null : "\"Later\" needs a time to come";
        }
        if (a.chose().isEmpty() && a.other() == null) {
            return "\"" + header + "\": pick an option or write your own answer";
        }
        if (!asked.multiSelect() && a.chose().size() > 1) {
            return "\"" + header + "\" takes one option";
        }
        for (String c : a.chose()) {
            if (!asked.options().contains(c)) {
                return "\"" + header + "\" has no option \"" + c + "\"";
            }
        }
        return null;
    }

    @Override
    public synchronized CommentOutcome withdraw(Actor actor, String cardId, long entryId, List<String> headers, String reason) {
        if (actor != Actor.CLAUDE) {
            return new CommentOutcome(CardChange.Outcome.INVALID, null, "Answer the question, or put it off with Later - withdrawing is Claude's");
        }
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return new CommentOutcome(CardChange.Outcome.NOT_FOUND, null, "No such card");
        }
        if (blank(reason)) {
            return new CommentOutcome(CardChange.Outcome.INVALID, null, "Say why the question is withdrawn - the user reads it");
        }
        ensureIndexed();
        Set<String> wanted = headers == null ? Set.of() : headers.stream().map(h -> h.strip().toLowerCase(Locale.ROOT)).collect(Collectors.toSet());
        List<Question> rows = store.questionsOf(cardId).stream().filter(q -> q.entryId() == entryId && !done(q)).toList();
        Set<Integer> taken = rows.stream().filter(q -> wanted.isEmpty() || wanted.contains(q.header().toLowerCase(Locale.ROOT)))
                .map(Question::idx).collect(Collectors.toSet());
        if (taken.isEmpty()) {
            return new CommentOutcome(CardChange.Outcome.INVALID, null, "[" + entryId + "] has no open question" + (wanted.isEmpty() ? "" : " by those headers"));
        }
        // A withdrawn question takes its follow-ups with it.
        rows.stream().filter(q -> q.parentIdx() != null && taken.contains(q.parentIdx())).forEach(q -> taken.add(q.idx()));
        List<String> names = rows.stream().filter(q -> taken.contains(q.idx())).map(Question::header).toList();
        Instant now = clock.instant();
        String text = "**Withdrawn** " + String.join(", ", names) + " - " + reason.strip();
        long id = store.append(new ActivityEntry(0, cardId, actor, ActivityKind.COMMENT, text, null, null, now, entryId));
        store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(id), cardId, MentionParser.mentions(text));
        rows.stream().filter(q -> taken.contains(q.idx())).forEach(q -> store.updateQuestion(q.with(QuestionState.WITHDRAWN, null, id)));
        Card next = found.get().touched(now, actor);
        store.update(next);
        next = syncDecision(next, actor, true);
        changed(next, "activity");
        return new CommentOutcome(CardChange.Outcome.OK, new ActivityEntry(id, cardId, actor, ActivityKind.COMMENT, text, null, null, now, entryId), null);
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
        waitOn(id, Waiting.USER, actor);
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange proposeMerge(Actor actor, String id, int intoNumber, String reason, String evidence) {
        if (actor != Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A proposal is Claude's - merge the cards yourself");
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        Optional<Card> into = store.findByNumber(card.project(), intoNumber);
        if (into.isEmpty() || into.get().id().equals(id)) {
            return CardChange.refused(CardChange.Outcome.INVALID, "Merge into another card of the same project: #" + intoNumber + " is not one");
        }
        if (card.status() == CardStatus.CLOSED || into.get().status() == CardStatus.CLOSED) {
            return CardChange.refused(CardChange.Outcome.INVALID, "Both cards must be open to merge");
        }
        return proposeAs(actor, card, new Proposal(id, CardStatus.CLOSED, Resolution.DUPLICATE, reason == null ? "" : reason.strip(),
                evidence == null ? "" : evidence.strip(), clock.instant(), Proposal.Kind.MERGE, into.get().id(), into.get().number()));
    }

    @Override
    public synchronized CardChange proposeReopen(Actor actor, String id, String reason, String evidence) {
        if (actor != Actor.CLAUDE) {
            return CardChange.refused(CardChange.Outcome.INVALID, "A proposal is Claude's - reopen the card yourself");
        }
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        if (!EnumSet.of(CardStatus.VERIFIED, CardStatus.DONE, CardStatus.CLOSED).contains(card.status())) {
            return CardChange.refused(CardChange.Outcome.INVALID, "Reopen can be proposed for a Verified, Done or closed card");
        }
        return proposeAs(actor, card, new Proposal(id, CardStatus.TO_DO, null, reason == null ? "" : reason.strip(),
                evidence == null ? "" : evidence.strip(), clock.instant(), Proposal.Kind.REOPEN, null, null));
    }

    private CardChange proposeAs(Actor actor, Card card, Proposal proposal) {
        if (proposal.reason().length() > MAX_REASON || proposal.evidence().length() > ProposeUseCase.MAX_EVIDENCE) {
            return CardChange.refused(CardChange.Outcome.INVALID, "reason or evidence too long");
        }
        store.putProposal(proposal);
        String text = proposal.reason() + (proposal.evidence().isEmpty() ? "" : "\n\n" + proposal.evidence());
        long entryId = store.append(new ActivityEntry(0, card.id(), actor, ActivityKind.PROPOSED, text.isBlank() ? null : text,
                card.status().name(), proposal.target(), clock.instant()));
        List<MentionRef> refs = MentionParser.mentions(text);
        if (!refs.isEmpty()) {
            store.replaceMentions(MentionOwner.ACTIVITY, Long.toString(entryId), card.id(), refs);
        }
        Card next = touched(card, actor, refs);
        waitOn(card.id(), Waiting.USER, actor);
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
        if (proposal.kind() == Proposal.Kind.MERGE) {
            return acceptMerge(actor, card, proposal);
        }
        if (proposal.kind() == Proposal.Kind.REOPEN) {
            return acceptReopen(actor, card, proposal);
        }
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

    private CardChange acceptMerge(Actor actor, Card source, Proposal proposal) {
        Optional<Card> target = store.find(proposal.intoCardId());
        store.deleteProposal(source.id());
        if (target.isEmpty() || target.get().status() == CardStatus.CLOSED || source.status() == CardStatus.CLOSED) {
            changed(source, "card");
            return CardChange.refused(CardChange.Outcome.CONFLICT, "The cards changed since Claude proposed this - the proposal is dropped");
        }
        store.mergeInto(source.id(), target.get().id());
        record(target.get().id(), actor, ActivityKind.MERGED, source.title(), null, "#" + source.number());
        record(source.id(), actor, ActivityKind.PROPOSAL_ACCEPTED, null, source.status().name(), proposal.target());
        Card closed = closeCard(actor, source, Resolution.DUPLICATE, "merged into #" + target.get().number());
        Card into = touched(target.get(), actor, List.of());
        mentionedCalls.mentionedCallsChanged();
        changed(closed, "card");
        changed(into, "card");
        return CardChange.ok(detail(into));
    }

    private CardChange acceptReopen(Actor actor, Card card, Proposal proposal) {
        store.deleteProposal(card.id());
        if (!EnumSet.of(CardStatus.VERIFIED, CardStatus.DONE, CardStatus.CLOSED).contains(card.status())) {
            changed(card, "card");
            return CardChange.refused(CardChange.Outcome.CONFLICT, "The card is open again already - the proposal is dropped");
        }
        record(card.id(), actor, ActivityKind.PROPOSAL_ACCEPTED, null, card.status().name(), proposal.target());
        Card next;
        if (card.status() == CardStatus.CLOSED) {
            next = card.withStatus(CardStatus.TO_DO, null, null, card.scope(), clock.instant(), actor);
            store.update(next);
            record(card.id(), actor, ActivityKind.REOPENED, null, card.resolution().name(), CardStatus.TO_DO.name());
            afterStatus(card.id(), CardStatus.TO_DO, actor);
        } else {
            next = moveCard(actor, card, CardStatus.TO_DO);
        }
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    // ------------------------------------------------------------------------------------------- blocked by, spec items

    @Override
    public synchronized CardChange block(Actor actor, String id, int blockedByNumber) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        Optional<Card> by = store.findByNumber(card.project(), blockedByNumber);
        if (by.isEmpty() || by.get().id().equals(id)) {
            return CardChange.refused(CardChange.Outcome.INVALID, "#" + blockedByNumber + " is not another card of this project");
        }
        if (store.blockersOf(List.of(by.get().id())).getOrDefault(by.get().id(), List.of()).stream().anyMatch(r -> r.number() == card.number())) {
            return CardChange.refused(CardChange.Outcome.INVALID, "#" + blockedByNumber + " is already blocked by this card");
        }
        store.addBlock(id, by.get().id());
        record(id, actor, ActivityKind.BLOCKED, by.get().title(), null, "#" + blockedByNumber);
        Card next = touched(card, actor, List.of());
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange unblock(Actor actor, String id, int blockedByNumber) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        Optional<Card> by = store.findByNumber(card.project(), blockedByNumber);
        if (by.isEmpty() || !store.removeBlock(id, by.get().id())) {
            return CardChange.refused(CardChange.Outcome.NOT_FOUND, "Not blocked by #" + blockedByNumber);
        }
        record(id, actor, ActivityKind.UNBLOCKED, null, "#" + blockedByNumber, null);
        Card next = touched(card, actor, List.of());
        changed(next, "card");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange linkSpecItem(Actor actor, String id, String cycleId, String fileName, String itemKey) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        String text = itemText(cycleId, fileName, itemKey);
        if (text == null) {
            return CardChange.refused(CardChange.Outcome.NOT_FOUND, "No acceptance item " + itemKey + " in " + fileName);
        }
        store.addSpecItem(id, cycleId, fileName, itemKey);
        record(id, actor, ActivityKind.SPEC_ITEM, text, null, fileName);
        Card next = touched(found.get(), actor, List.of());
        changed(next, "card");
        notifications.changed(null, cycleId, null, "checklist");
        return CardChange.ok(detail(next));
    }

    @Override
    public synchronized CardChange unlinkSpecItem(Actor actor, String id, String cycleId, String fileName, String itemKey) {
        Optional<Card> found = store.find(id);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        if (!store.removeSpecItem(id, cycleId, fileName, itemKey)) {
            return CardChange.refused(CardChange.Outcome.NOT_FOUND, "Not linked");
        }
        Card next = touched(found.get(), actor, List.of());
        changed(next, "card");
        notifications.changed(null, cycleId, null, "checklist");
        return CardChange.ok(detail(next));
    }

    private String itemText(String cycleId, String fileName, String itemKey) {
        return store.spec(cycleId, fileName).flatMap(f -> AcceptanceItems.of(f.content()).stream().filter(i -> i.key().equals(itemKey))
                .findFirst()).map(AcceptanceItems.Item::text).orElse(null);
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
        waitOn(id, Waiting.CLAUDE, actor);
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
        Map<String, WaitingOn> waiting = store.waitings(ids);
        Map<String, List<CardRef>> blockers = store.blockersOf(ids);
        ensureIndexed();
        Map<String, Integer> questions = store.openQuestionCounts(ids, clock.instant());
        Map<String, String> advice = questions.isEmpty() ? Map.of() : store.openQuestionAdvice(questions.keySet(), clock.instant());
        Map<String, String> shortNames = ids.isEmpty() ? Map.of() : store.shortNames("card", ids);
        Map<String, Map<String, SimilarClosed>> similar = new LinkedHashMap<>();
        cards.stream().filter(c -> c.status() == CardStatus.INBOX && c.signature() != null)
                .collect(Collectors.groupingBy(Card::project, Collectors.mapping(Card::signature, Collectors.toSet())))
                .forEach((project, sigs) -> similar.put(project, store.closedBySignature(project, sigs)));
        List<CardSummary> rows = cards.stream().map(c -> new CardSummary(c, comments.getOrDefault(c.id(), 0),
                chips.getOrDefault(c.id(), List.of()),
                c.status() == CardStatus.INBOX && c.signature() != null
                        ? hintFor(c, similar.getOrDefault(c.project(), Map.of()).get(c.signature())) : null, proposals.get(c.id()), waiting.get(c.id()),
                blockers.get(c.id()), questions.getOrDefault(c.id(), 0), advice.get(c.id()), shortNames.get(c.id()))).toList();
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

    /**
     * Whether a new card is the very thing the user dismissed as {@code closed} (same signature already established): it
     * names one of the closed card's calls, or its title shares at least {@link #DISMISSED_SHARED_WORDS} words with the closed
     * card's beyond the endpoint's own words. Two cards on one endpoint share its name whatever they found ("flight search
     * slow", "flight search answers 500"), so the words of the signature's endpoint never count: with them, one dismissed
     * card closed that endpoint to every later finding. The same endpoint failing the same way for another reason is a
     * new finding, shown with the closed card as a hint.
     * <p>A shared call counts only between cards of the same kind: one call can show several problems, and the user
     * dismissed one of them. A NOTE closed as Fine over a slow search (61813's #39) must not hide a TASK saying the same
     * searches lack a feature, nor a BUG in their result; another NOTE over those calls is the dismissed one again.
     */
    private boolean repeatsDismissed(String project, SimilarClosed closed, List<MentionRef> mentions, String title, CardKind kind,
                                     String signature) {
        Set<String> endpointWords = new HashSet<>(BoardInsightsService.words(signature.replace('|', ' ')));
        List<String> own = BoardInsightsService.words(title).stream().filter(w -> !endpointWords.contains(w)).toList();
        if (BoardInsightsService.sharedWords(own, closed.title()).size() >= DISMISSED_SHARED_WORDS) {
            return true;
        }
        Set<String> callIds = mentions.stream().map(MentionRef::callId).filter(Objects::nonNull).collect(Collectors.toSet());
        if (callIds.isEmpty()) {
            return false;
        }
        return store.findByNumber(project, closed.number())
                .map(card -> card.kind() == kind
                        && store.linksOf(card.id()).stream().map(MentionRef::callId).filter(Objects::nonNull).anyMatch(callIds::contains))
                .orElse(false);
    }

    /**
     * The "Looks like #N, closed as Fine" hint, only for a card that could be that problem: the same kind, or a title
     * sharing a word with the closed card's beyond the endpoint's own words. A signature is only the endpoint and its
     * outcome class, so without this every finding on a dismissed endpoint carried the hint: 61813's missing-feature
     * TASKs all said "Looks like #39" - a NOTE about a debugger stall on the same search.
     */
    private SimilarClosed hintFor(Card card, SimilarClosed closed) {
        if (closed == null || closed.kind() == null || closed.kind() == card.kind() || card.signature() == null) {
            return closed;
        }
        Set<String> endpointWords = new HashSet<>(BoardInsightsService.words(card.signature().replace('|', ' ')));
        List<String> own = BoardInsightsService.words(card.title()).stream().filter(w -> !endpointWords.contains(w)).toList();
        return BoardInsightsService.sharedWords(own, closed.title()).isEmpty() ? null : closed;
    }

    private CardDetail detail(Card card) {
        Card full = card.description().isEmpty() ? store.find(card.id()).orElse(card) : card;
        SimilarClosed similar = full.status() == CardStatus.INBOX && full.signature() != null
                ? hintFor(full, store.closedBySignature(full.project(), List.of(full.signature())).get(full.signature())) : null;
        SimilarOpen open = full.status() != CardStatus.CLOSED && full.signature() != null ? similarOpen(full) : null;
        int comments = store.commentCounts(List.of(full.id())).getOrDefault(full.id(), 0);
        List<SpecItemLink> items = store.specItemsOf(full.id()).stream()
                .map(r -> new SpecItemLink(r[0], r[1], r[2], itemText(r[0], r[1], r[2]))).toList();
        return new CardDetail(full, comments, store.linksOf(full.id()), similar, store.proposal(full.id()).orElse(null),
                store.waiting(full.id()).orElse(null), items, store.blockersOf(List.of(full.id())).getOrDefault(full.id(), List.of()), open,
                unansweredQuestions(full.id()), store.shortNames("card", List.of(full.id())).get(full.id()));
    }

    /** The most recently updated other card still open on this card's signature. */
    private SimilarOpen similarOpen(Card card) {
        return store.openBySignature(card.project(), List.of(card.signature())).getOrDefault(card.signature(), List.of()).stream()
                .filter(other -> !other.id().equals(card.id())).findFirst()
                .map(other -> new SimilarOpen(other.number(), other.title(), other.status())).orElse(null);
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
            case DUPLICATE -> "Duplicate";
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
