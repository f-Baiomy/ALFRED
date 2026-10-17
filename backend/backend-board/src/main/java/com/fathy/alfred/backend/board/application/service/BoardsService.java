package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.GetCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardHomeUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.application.port.in.TaskDataUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.board.application.port.out.LinkedWorkItemPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardActivity;
import com.fathy.alfred.backend.board.domain.model.BoardActivity.Kind;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.BoardOutcome;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.BoardSummary;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Boards as tasks (specs/027): a board holds the brief, spec files, Acceptance items, chat and cards; the session cycles
 * related to it are its recordings and re-tests, many-to-many and across projects. Claude may relate and unrelate and move
 * card homes (each with Undo in the board's activity), may open a board only on the user's request it can name
 * (FR-040, research R13a), and may never rename, mark done, archive or delete one (FR-001b).
 */
@Service
public class BoardsService implements ManageBoardsUseCase, RelateCycleUseCase, MoveCardHomeUseCase {

    /** How old the user's asking chat message may be when Claude opens a board for it. */
    static final Duration ASKED_WINDOW = Duration.ofMinutes(30);
    static final String ASKED_IN_TERMINAL = "terminal";

    private final BoardModelStorePort boards;
    private final BoardStorePort cards;
    private final ChatStorePort chats;
    private final GetCardUseCase cardDetails;
    private final TaskDataUseCase taskData;
    private final BoardNotificationPort notifications;
    private final ObjectProvider<CycleControlPort> cycles;
    private final ObjectProvider<LinkedWorkItemPort> linked;
    private final Clock clock;

    @Value("${alfred.board.activity-max-rows:2000}")
    private int activityMaxRows = 2000;

    @Autowired
    public BoardsService(BoardModelStorePort boards, BoardStorePort cards, ChatStorePort chats, GetCardUseCase cardDetails,
                         TaskDataUseCase taskData, BoardNotificationPort notifications, BoardChangeFeed feed,
                         ObjectProvider<CycleControlPort> cycles, ObjectProvider<LinkedWorkItemPort> linked) {
        this(boards, cards, chats, cardDetails, taskData, feed.feeding(notifications), cycles, linked, Clock.systemUTC());
    }

    BoardsService(BoardModelStorePort boards, BoardStorePort cards, ChatStorePort chats, GetCardUseCase cardDetails,
                  TaskDataUseCase taskData, BoardNotificationPort notifications, ObjectProvider<CycleControlPort> cycles,
                  ObjectProvider<LinkedWorkItemPort> linked, Clock clock) {
        this.boards = boards;
        this.cards = cards;
        this.chats = chats;
        this.cardDetails = cardDetails;
        this.taskData = taskData;
        this.notifications = notifications;
        this.cycles = cycles;
        this.linked = linked;
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------------ boards

    @Override
    public List<BoardSummary> list(String project, Set<BoardState> states, String q, int limit) {
        List<Board> found = new java.util.ArrayList<>(boards.boards(project, states, q, Math.max(1, Math.min(limit <= 0 ? MAX_LIMIT : limit, MAX_LIMIT))));
        if (project != null && !project.isBlank() && found.stream().noneMatch(Board::isDefault) && (q == null || q.isBlank())
                && (states == null || states.isEmpty() || states.contains(BoardState.OPEN))) {
            found.add(0, readDefault(project)); // a read never writes: the default board is saved on its first write
        }
        Map<String, Integer> counts = boards.cardCounts(found.stream().map(Board::id).toList());
        return found.stream().map(b -> summary(b, counts.getOrDefault(b.id(), 0))).toList();
    }

    @Override
    public Optional<BoardSummary> get(String id) {
        Optional<Board> b = boards.board(id);
        if (b.isEmpty() && BoardIds.isDefault(id)) {
            b = Optional.of(readDefault(BoardIds.projectOfDefault(id)));
        }
        return b.map(board -> summary(board, boards.cardCounts(List.of(board.id())).getOrDefault(board.id(), 0)));
    }

    private BoardSummary summary(Board b, int cardCount) {
        String item = linkedPort().linkedTo(b.id()).map(l -> l.connection() + "/" + l.itemId()).orElse(null);
        return new BoardSummary(b, cardCount, boards.cyclesOf(b.id()), boards.relatedBoards(b.id()), item);
    }

    /** A board to write to: a project's default board is saved here, on its first write. */
    private Optional<Board> writable(String id) {
        Optional<Board> b = boards.board(id);
        return b.isEmpty() && BoardIds.isDefault(id) && !BoardIds.projectOfDefault(id).isBlank()
                ? Optional.of(defaultBoard(BoardIds.projectOfDefault(id))) : b;
    }

    /** The project's default board as it is or would be - read paths (open to the tunnel) never save it. */
    private Board readDefault(String project) {
        return boards.board(BoardIds.defaultOf(project)).orElseGet(() ->
                new Board(BoardIds.defaultOf(project), project, project, true, BoardState.OPEN, null, clock.instant(), clock.instant(), Actor.USER));
    }

    @Override
    public synchronized Board defaultBoard(String project) {
        return DefaultBoards.ensure(boards, project, clock.instant());
    }

    @Override
    public Result create(Actor actor, NewBoard in) {
        if (in == null || in.project() == null || in.project().isBlank()) {
            return Result.of(BoardOutcome.REFUSED, "A board needs a project");
        }
        String name = in.name() == null ? "" : in.name().strip();
        if (name.isEmpty() || name.length() > Board.MAX_NAME) {
            return Result.of(BoardOutcome.REFUSED, "A board's name is 1 to " + Board.MAX_NAME + " characters");
        }
        String askedNote = null;
        if (actor == Actor.CLAUDE) {
            Optional<String> asked = askedBy(in.askedIn());
            if (asked.isEmpty()) {
                return Result.of(BoardOutcome.NOT_ASKED, "Claude opens a board only when the user asked: name the asking chat message "
                        + "(askedIn) or \"terminal\"");
            }
            askedNote = asked.get();
        }
        defaultBoard(in.project());
        Instant now = clock.instant();
        Board board = new Board(UUID.randomUUID().toString(), in.project(), name, false, BoardState.OPEN, null, now, now, actor);
        boards.putBoard(board);
        log(board.id(), actor, Kind.CREATED, askedNote == null ? "opened the board" : "opened the board " + askedNote, null);
        for (String cycleId : in.cycleIds()) {
            if (cycleId != null && !cycleId.isBlank() && boards.relateCycle(board.id(), cycleId, actor, now)) {
                log(board.id(), actor, Kind.RELATE_CYCLE, "related cycle " + cycleId, null);
            }
        }
        if (in.relateTo() != null && !in.relateTo().isBlank() && writable(in.relateTo()).isPresent()
                && boards.relateBoards(board.id(), in.relateTo())) {
            log(board.id(), actor, Kind.RELATE_BOARD, "related board " + in.relateTo(), null);
        }
        if (in.startRecording()) {
            // one project records into one cycle at a time (FR-008): a first recording pauses the project's running one
            for (String running : cyclePort().recordingCycles()) {
                if (boards.boardsOfCycle(running).stream().map(boards::board).flatMap(Optional::stream)
                        .anyMatch(o -> o.project().equals(in.project()))) {
                    cyclePort().pause(running);
                }
            }
            cyclePort().create(name).ifPresent(cycleId -> {
                boards.relateCycle(board.id(), cycleId, actor, now);
                log(board.id(), actor, Kind.RELATE_CYCLE, "started its first recording", null);
            });
        }
        changed(board.project(), board.id());
        return new Result(BoardOutcome.OK, board, null);
    }

    /** What Claude's opening is recorded with; empty when {@code askedIn} names no recent request of the user. */
    private Optional<String> askedBy(String askedIn) {
        if (askedIn == null || askedIn.isBlank()) {
            return Optional.empty();
        }
        if (ASKED_IN_TERMINAL.equalsIgnoreCase(askedIn.strip())) {
            return Optional.of("at your request in the terminal");
        }
        long id;
        try {
            id = Long.parseLong(askedIn.strip());
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
        Optional<ChatMessage> m = chats.find(id);
        if (m.isEmpty() || m.get().author() != ChatMessage.Author.USER || m.get().createdAt() == null
                || m.get().createdAt().isBefore(clock.instant().minus(ASKED_WINDOW))) {
            return Optional.empty();
        }
        return Optional.of("as you asked in chat #" + id);
    }

    @Override
    public Result update(Actor actor, String id, String name, BoardState state) {
        Optional<Board> found = writable(id);
        if (found.isEmpty()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board");
        }
        if (actor == Actor.CLAUDE) {
            return Result.of(BoardOutcome.REFUSED_FOR_CLAUDE, "Renaming a board and its state are the user's");
        }
        Board b = found.get();
        Instant now = clock.instant();
        if (state != null && state != b.state() && b.isDefault()) {
            return Result.of(BoardOutcome.DEFAULT_PROTECTED, "A project's default board stays open");
        }
        if (name != null && !name.isBlank() && name.strip().length() > Board.MAX_NAME) {
            return Result.of(BoardOutcome.REFUSED, "A board's name is 1 to " + Board.MAX_NAME + " characters");
        }
        if (name != null && !name.isBlank() && !name.strip().equals(b.name())) {
            if (name.strip().length() > Board.MAX_NAME) {
                return Result.of(BoardOutcome.REFUSED, "A board's name is 1 to " + Board.MAX_NAME + " characters");
            }
            b = b.renamed(name.strip(), now, actor);
            log(id, actor, Kind.RENAMED, "renamed it " + b.name(), null);
        }
        if (state != null && state != b.state()) {
            b = b.withState(state, now, actor);
            log(id, actor, Kind.STATE, "marked it " + state.name().toLowerCase(java.util.Locale.ROOT), null);
        }
        boards.putBoard(b);
        changed(b.project(), id);
        return new Result(BoardOutcome.OK, b, null);
    }

    @Override
    public Result delete(Actor actor, String id) {
        Optional<Board> found = boards.board(id);
        if (found.isEmpty()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board");
        }
        if (actor == Actor.CLAUDE) {
            return Result.of(BoardOutcome.REFUSED_FOR_CLAUDE, "Deleting a board is the user's");
        }
        Board b = found.get();
        if (b.isDefault()) {
            return Result.of(BoardOutcome.DEFAULT_PROTECTED, "A project's default board cannot be deleted");
        }
        // Its cycles and their calls stay (they are not the board's); its cards go to the project's default board.
        Board fallback = defaultBoard(b.project());
        boards.deleteBoard(id, fallback.id());
        taskData.taskRemoved(id);
        linkedPort().boardDeleted(id);
        changed(b.project(), fallback.id());
        return new Result(BoardOutcome.OK, b, null);
    }

    @Override
    public List<BoardActivity> activity(String id, long after, int limit) {
        return boards.activity(id, Math.max(0, after), Math.max(1, Math.min(limit <= 0 ? MAX_LIMIT : limit, MAX_LIMIT)));
    }

    @Override
    public Result undo(Actor actor, String boardId, long activityId) {
        Optional<BoardActivity> found = boards.activityEntry(activityId);
        if (found.isEmpty() || found.get().undo() == null || (boardId != null && !boardId.equals(found.get().boardId()))) {
            return Result.of(BoardOutcome.NOT_FOUND, "Nothing to undo");
        }
        BoardActivity a = found.get();
        BoardActivity.Undo u = a.undo();
        if (u.kind() == Kind.MOVE_HOME_IN) {
            // the card must still be where the move put it; its old board may be gone (then: the project's default board)
            Optional<Card> card = cards.find(u.cardId());
            if (card.isEmpty() || !u.boardId().equals(card.get().boardId())) {
                return Result.of(BoardOutcome.REFUSED, "The card has moved since");
            }
            if (boards.board(u.otherId()).isEmpty()) {
                u = new BoardActivity.Undo(u.kind(), u.boardId(), defaultBoard(card.get().project()).id(), u.cardId());
            }
        }
        // claimed first, applied after: two Undos at once apply it once
        if (a.undoneAt() != null || !boards.markUndone(activityId, clock.instant())) {
            return Result.of(BoardOutcome.REFUSED, "Already undone");
        }
        switch (u.kind()) {
            case RELATE_CYCLE -> boards.unrelateCycle(u.boardId(), u.otherId());
            case UNRELATE_CYCLE -> boards.relateCycle(u.boardId(), u.otherId(), actor, clock.instant());
            case RELATE_BOARD -> boards.unrelateBoards(u.boardId(), u.otherId());
            case UNRELATE_BOARD -> boards.relateBoards(u.boardId(), u.otherId());
            case MOVE_HOME_IN -> boards.setHome(u.cardId(), u.otherId(), clock.instant(), actor);
            default -> {
                return Result.of(BoardOutcome.REFUSED, "That change cannot be undone");
            }
        }
        Board b = boards.board(a.boardId()).orElse(null);
        changed(b == null ? null : b.project(), a.boardId());
        return new Result(BoardOutcome.OK, b, null);
    }

    // --------------------------------------------------------------------------------------------------------- relations

    @Override
    public Result relateCycle(Actor actor, String boardId, String cycleId) {
        Optional<Board> b = writable(boardId);
        if (b.isEmpty() || cycleId == null || cycleId.isBlank()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board or cycle");
        }
        if (boards.relateCycle(boardId, cycleId, actor, clock.instant())) {
            log(boardId, actor, Kind.RELATE_CYCLE, "related cycle " + cycleId,
                    actor == Actor.CLAUDE ? new BoardActivity.Undo(Kind.RELATE_CYCLE, boardId, cycleId, null) : null);
            changed(b.get().project(), boardId);
        }
        return new Result(BoardOutcome.OK, b.get(), null);
    }

    @Override
    public Result unrelateCycle(Actor actor, String boardId, String cycleId) {
        Optional<Board> b = writable(boardId);
        if (b.isEmpty()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board");
        }
        if (boards.unrelateCycle(boardId, cycleId)) {
            log(boardId, actor, Kind.UNRELATE_CYCLE, "unrelated cycle " + cycleId,
                    actor == Actor.CLAUDE ? new BoardActivity.Undo(Kind.UNRELATE_CYCLE, boardId, cycleId, null) : null);
            changed(b.get().project(), boardId);
        }
        return new Result(BoardOutcome.OK, b.get(), null);
    }

    @Override
    public Result relateBoard(Actor actor, String boardId, String otherId) {
        Optional<Board> b = writable(boardId);
        Optional<Board> other = writable(otherId);
        if (b.isEmpty() || other.isEmpty()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board");
        }
        if (boards.relateBoards(boardId, otherId)) {
            log(boardId, actor, Kind.RELATE_BOARD, "related board " + other.get().name(),
                    actor == Actor.CLAUDE ? new BoardActivity.Undo(Kind.RELATE_BOARD, boardId, otherId, null) : null);
            changed(b.get().project(), boardId);
        }
        return new Result(BoardOutcome.OK, b.get(), null);
    }

    @Override
    public Result unrelateBoard(Actor actor, String boardId, String otherId) {
        Optional<Board> b = writable(boardId);
        if (b.isEmpty()) {
            return Result.of(BoardOutcome.NOT_FOUND, "No such board");
        }
        if (boards.unrelateBoards(boardId, otherId)) {
            log(boardId, actor, Kind.UNRELATE_BOARD, "unrelated board " + otherId,
                    actor == Actor.CLAUDE ? new BoardActivity.Undo(Kind.UNRELATE_BOARD, boardId, otherId, null) : null);
            changed(b.get().project(), boardId);
        }
        return new Result(BoardOutcome.OK, b.get(), null);
    }

    @Override
    public List<String> cyclesOf(String boardId) {
        return boards.cyclesOf(boardId);
    }

    @Override
    public List<String> boardsOfCycle(String cycleId) {
        return boards.boardsOfCycle(cycleId);
    }

    @Override
    public List<String> cyclesOfTask(String taskKey) {
        return BoardCycles.of(boards, taskKey);
    }

    // ---------------------------------------------------------------------------------------------------------- homes

    @Override
    public CardChange moveHome(Actor actor, String cardId, String boardId) {
        Optional<Card> card = cards.find(cardId);
        Optional<Board> target = writable(boardId);
        if (card.isEmpty() || target.isEmpty()) {
            return CardChange.notFound();
        }
        if (!target.get().project().equals(card.get().project())) {
            // a card's number is its project's: its home stays in its project (related boards of other projects still show it)
            return CardChange.refused(CardChange.Outcome.INVALID, "A card's home is a board of its own project");
        }
        String from = card.get().boardId();
        if (!from.equals(boardId)) {
            boards.setHome(cardId, boardId, clock.instant(), actor);
            String label = card.get().project() + "#" + card.get().number();
            log(boardId, actor, Kind.MOVE_HOME_IN, "moved " + label + " here from " + boardName(from),
                    actor == Actor.CLAUDE ? new BoardActivity.Undo(Kind.MOVE_HOME_IN, boardId, from, cardId) : null);
            if (boards.board(from).isPresent()) {
                log(from, actor, Kind.MOVE_HOME_OUT, "moved " + label + " to " + target.get().name(), null);
            }
            notifications.changed(card.get().project(), boardId, cardId, "card");
            notifications.changed(card.get().project(), from, cardId, "card");
        }
        return cardDetails.get(cardId).map(CardChange::ok).orElseGet(CardChange::notFound);
    }

    @Override
    public CardChange relateCardCycle(Actor actor, String cardId, String cycleId) {
        Optional<Card> card = cards.find(cardId);
        if (card.isEmpty() || cycleId == null || cycleId.isBlank()) {
            return CardChange.notFound();
        }
        if (!cycleId.equals(card.get().cycleId()) && boards.relateCardCycle(cardId, cycleId)) {
            changed(card.get().project(), card.get().boardId());
        }
        return cardDetails.get(cardId).map(CardChange::ok).orElseGet(CardChange::notFound);
    }

    @Override
    public CardChange unrelateCardCycle(Actor actor, String cardId, String cycleId) {
        Optional<Card> card = cards.find(cardId);
        if (card.isEmpty()) {
            return CardChange.notFound();
        }
        if (boards.unrelateCardCycle(cardId, cycleId)) {
            changed(card.get().project(), card.get().boardId());
        }
        return cardDetails.get(cardId).map(CardChange::ok).orElseGet(CardChange::notFound);
    }

    @Override
    public List<String> relatedCycles(String cardId) {
        return boards.cardCycles(cardId);
    }

    // ---------------------------------------------------------------------------------------------------------- helpers

    private String boardName(String id) {
        return boards.board(id).map(Board::name).orElse(id);
    }

    private void log(String boardId, Actor actor, Kind kind, String text, BoardActivity.Undo undo) {
        boards.addActivity(new BoardActivity(0, boardId, actor, kind, text, undo, clock.instant(), null), activityMaxRows);
    }

    private void changed(String project, String boardId) {
        notifications.changed(project, boardId, null, "boards");
    }

    private CycleControlPort cyclePort() {
        CycleControlPort p = cycles.getIfAvailable();
        return p == null ? new CycleControlPort() { } : p;
    }

    private LinkedWorkItemPort linkedPort() {
        LinkedWorkItemPort p = linked.getIfAvailable();
        return p == null ? new LinkedWorkItemPort() { } : p;
    }

    /** For tests. */
    void activityMaxRows(int n) {
        this.activityMaxRows = n;
    }
}
