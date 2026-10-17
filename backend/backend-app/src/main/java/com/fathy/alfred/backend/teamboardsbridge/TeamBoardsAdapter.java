package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.board.application.port.in.BoardFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.CardOwnerUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.GetCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ProposeUseCase;
import com.fathy.alfred.backend.board.application.port.in.QueryCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SearchCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * The Team slice's way into Alfred's boards (specs/027 US8, 028 US3-US6): a start is the user's waiting /alfred-setup
 * message in the target board's chat; a card made from a tracker item is a card like any other (Claude's in the Inbox);
 * a closed or reopened item becomes Claude's proposal on the card, which the user accepts or dismisses.
 */
@Component
public class TeamBoardsAdapter implements TeamBoardsPort {

    static final String START_ORIGIN = "team-start";

    private final ManageBoardsUseCase boards;
    private final ChatUseCase chats;
    private final BoardFilesUseCase files;
    private final LiveWorkUseCase live;
    private final ObjectProvider<ManageDbCaptureUseCase> projects;
    private final GetCardUseCase getCard;
    private final QueryCardsUseCase query;
    private final SearchCardsUseCase search;
    private final CreateCardUseCase create;
    private final UpdateCardUseCase update;
    private final ProposeUseCase propose;
    private final CardOwnerUseCase owners;

    public TeamBoardsAdapter(ManageBoardsUseCase boards, ChatUseCase chats, BoardFilesUseCase files, LiveWorkUseCase live,
                             ObjectProvider<ManageDbCaptureUseCase> projects, GetCardUseCase getCard, QueryCardsUseCase query, SearchCardsUseCase search,
                             CreateCardUseCase create, UpdateCardUseCase update, ProposeUseCase propose, CardOwnerUseCase owners) {
        this.boards = boards;
        this.chats = chats;
        this.files = files;
        this.live = live;
        this.projects = projects;
        this.getCard = getCard;
        this.query = query;
        this.search = search;
        this.create = create;
        this.update = update;
        this.propose = propose;
        this.owners = owners;
    }

    @Override
    public boolean projectExists(String project) {
        if (project == null || project.isBlank()) {
            return false;
        }
        var capture = projects.getIfAvailable();
        if (capture != null && capture.projects().stream().anyMatch(p -> project.equals(p.project()))) {
            return true; // a project Alfred fronts
        }
        // the default board is listed for any name (a read never writes it), so it counts only once it holds cards
        return boards.list(project, EnumSet.allOf(BoardState.class), null, 2).stream()
                .anyMatch(s -> project.equals(s.board().project()) && (!s.board().isDefault() || s.cards() > 0));
    }

    @Override
    public String whoAnswers(String project, String boardId) {
        if (boardId != null && live.cycleChat(boardId).isPresent()) {
            return "the terminal holding this board";
        }
        return live.runner(project).isPresent() ? "the project's live runner" : null;
    }

    /** A board's chat; the default board's is the project chat. */
    static ChatKey chatOf(String project, String boardId) {
        return new ChatKey(project, boardId == null ? "" : boardId);
    }

    @Override
    public Optional<String> projectOf(String boardId) {
        if (boardId == null || boardId.isBlank()) {
            return Optional.empty();
        }
        return boards.get(boardId).map(s -> s.board().project());
    }

    @Override
    public Optional<String> boardName(String boardId) {
        if (boardId == null || boardId.isBlank()) {
            return Optional.empty();
        }
        return boards.get(boardId).map(s -> s.board().name());
    }

    @Override
    public MadeBoard createBoard(String project, String name, FirstCycle cycle, boolean asClaude, String askedIn) {
        ManageBoardsUseCase.Result r = boards.create(asClaude ? Actor.CLAUDE : Actor.USER, new ManageBoardsUseCase.NewBoard(project, name, List.of(),
                null, cycle == FirstCycle.RECORD, askedIn, cycle == FirstCycle.NEW));
        return r.board() == null ? new MadeBoard(null, r.message()) : new MadeBoard(r.board().id(), null);
    }

    @Override
    public void deleteBoard(String boardId) {
        boards.delete(Actor.USER, boardId);
    }

    @Override
    public Optional<String> boardNamed(String project, String name) {
        String key = name.strip().toLowerCase(Locale.ROOT);
        return boards.list(project, EnumSet.of(BoardState.OPEN), null, ManageBoardsUseCase.MAX_LIMIT).stream()
                .filter(s -> project.equals(s.board().project()) && !s.board().isDefault() && s.board().name().strip().toLowerCase(Locale.ROOT).equals(key))
                .map(s -> s.board().id()).findFirst();
    }

    @Override
    public Optional<Long> postStart(String project, String boardId, String text) {
        if (boardId != null && !projectOf(boardId).map(project::equals).orElse(false)) {
            return Optional.empty();
        }
        ChatUseCase.Result<ChatMessage> r = chats.post(Actor.USER, chatOf(project, boardId),
                new ChatUseCase.Post(text, null, List.of(), null, false, START_ORIGIN, List.of()));
        return r.outcome() == CardChange.Outcome.OK ? Optional.of(r.value().id()) : Optional.empty();
    }

    @Override
    public boolean withdrawStart(long messageId) {
        return chats.cancel(Actor.USER, messageId).outcome() == CardChange.Outcome.OK; // refused once the setup was taken
    }

    @Override
    public boolean askedBy(String askedIn) {
        return boards.askedBy(askedIn).isPresent();
    }

    @Override
    public Set<String> files(String boardId) {
        com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result<List<BoardFile>> r = files.files(null, boardId);
        return r.value() == null ? Set.of() : r.value().stream().map(BoardFile::name).collect(Collectors.toSet());
    }

    @Override
    public String attach(String boardId, String name, byte[] data) {
        Optional<String> project = projectOf(boardId);
        if (project.isEmpty()) {
            return "no such board";
        }
        com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result<BoardFile> r = files.attach(Actor.USER, null, boardId, project.get(), name, data);
        return r.outcome() == CardChange.Outcome.OK ? null : r.message() == null ? "not stored" : r.message();
    }

    // ---------------------------------------------------------------------------------------------------------- cards

    static CardInfo info(Card c) {
        return new CardInfo(c.id(), c.boardId(), c.project(), c.number(), c.kind().name(), c.title(), c.description(), c.status().name(),
                c.resolution() == null ? null : c.resolution().name());
    }

    @Override
    public Optional<CardInfo> card(String cardId) {
        if (cardId == null || cardId.isBlank()) {
            return Optional.empty();
        }
        return getCard.get(cardId).map(d -> info(d.card()));
    }

    @Override
    public List<CardInfo> cardsOfBoard(String boardId, int limit) {
        Optional<String> project = projectOf(boardId);
        if (project.isEmpty()) {
            return List.of();
        }
        Set<CardStatus> open = EnumSet.complementOf(EnumSet.of(CardStatus.CLOSED));
        CardQuery q = new CardQuery(project.get(), null, null, open, null, null, false, null, 0, Math.max(1, Math.min(limit, 500)), false, null, false)
                .onBoard(boardId, false);
        return query.query(q).cards().stream().map(s -> info(s.card())).toList();
    }

    static Set<String> words(String s) {
        Set<String> out = new LinkedHashSet<>();
        if (s == null) {
            return out;
        }
        for (String w : s.toLowerCase(Locale.ROOT).replaceAll("<[^>]+>", " ").split("[^\\p{L}\\p{N}]+")) {
            if (w.length() > 2) {
                out.add(w);
            }
        }
        return out;
    }

    /** How alike two titles are, 0..100 (shared words over all words). */
    static int score(String a, String b) {
        Set<String> x = words(a);
        Set<String> y = words(b);
        if (x.isEmpty() || y.isEmpty()) {
            return 0;
        }
        Set<String> both = new LinkedHashSet<>(x);
        both.retainAll(y);
        Set<String> all = new LinkedHashSet<>(x);
        all.addAll(y);
        return (int) Math.round(100.0 * both.size() / all.size());
    }

    @Override
    public List<Similar> similar(String boardId, String title, String text, int limit) {
        Optional<String> project = projectOf(boardId);
        if (project.isEmpty() || title == null || title.isBlank()) {
            return List.of();
        }
        List<Similar> out = new ArrayList<>();
        for (SearchCardsUseCase.Similar s : search.similar(project.get(), title, null, Math.max(limit * 3, 10))) {
            Card c = s.card().card();
            if (c.status() == CardStatus.CLOSED) {
                continue;
            }
            int score = score(title, c.title());
            if (boardId.equals(c.boardId())) {
                score = Math.min(100, score + 10); // this board's own cards first
            }
            out.add(new Similar(info(c), score, s.why()));
        }
        out.sort((a, b) -> Integer.compare(b.score(), a.score()));
        return out.size() > limit ? out.subList(0, limit) : out;
    }

    @Override
    public Optional<String> createCard(String boardId, boolean asClaude, String kind, String title, String description, String[] why) {
        Optional<String> project = projectOf(boardId);
        if (project.isEmpty()) {
            why[0] = "No board " + boardId;
            return Optional.empty();
        }
        CardKind k;
        try {
            k = CardKind.valueOf(kind);
        } catch (IllegalArgumentException | NullPointerException e) {
            k = CardKind.NOTE;
        }
        String t = title == null ? "" : title.strip();
        if (t.length() > 300) {
            t = t.substring(0, 299) + "…";
        }
        CardChange r = create.create(asClaude ? Actor.CLAUDE : Actor.USER, new CreateCardUseCase.NewCard(project.get(), k, t, description, null, boardId,
                asClaude ? CardStatus.INBOX : CardStatus.TO_DO, List.of()));
        if (r.outcome() != CardChange.Outcome.OK || r.card() == null) {
            why[0] = r.message();
            return Optional.empty();
        }
        return Optional.of(r.card().card().id());
    }

    @Override
    public boolean appendToDescription(String cardId, String text) {
        Optional<Card> c = getCard.get(cardId).map(d -> d.card());
        if (c.isEmpty()) {
            return false;
        }
        String now = c.get().description() == null ? "" : c.get().description();
        String next = now.isBlank() ? text : now.stripTrailing() + "\n\n" + text;
        return update.update(Actor.USER, cardId, new UpdateCardUseCase.CardEdit(null, next, null, null, null, null, null)).outcome()
                == CardChange.Outcome.OK;
    }

    @Override
    public boolean propose(String cardId, String status, String resolution, String reason) {
        CardStatus s;
        Resolution r = null;
        try {
            s = CardStatus.valueOf(status);
            if (resolution != null) {
                r = Resolution.valueOf(resolution);
            }
        } catch (IllegalArgumentException e) {
            return false;
        }
        return propose.propose(Actor.CLAUDE, cardId, s, r, reason, "").outcome() == CardChange.Outcome.OK;
    }

    @Override
    public boolean proposeReopen(String cardId, String reason) {
        return propose.proposeReopen(Actor.CLAUDE, cardId, reason, "").outcome() == CardChange.Outcome.OK;
    }

    @Override
    public PersonCards cardsOf(String conn, String personId, int limit) {
        CardOwnerUseCase.PersonCards p = owners.cardsOf(conn + "/" + personId, limit);
        return new PersonCards(p.owned().stream().map(TeamBoardsAdapter::info).toList(), p.mentioning().stream().map(TeamBoardsAdapter::info).toList());
    }
}
