package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite.SqliteTeamCacheRepository;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.IncomingUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.WatchRulesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executor;

/** Every Team service over a real teamboards.db in a temp folder, a fake tracker and fake boards. */
final class TeamFixture {

    static final String CONN = "c1";

    final FakeTracker tracker = new FakeTracker();
    final SqliteTeamCacheRepository cache;
    final TokenVault vault = new TokenVault();
    final Live live;
    final List<String> signals = new ArrayList<>();
    final FakeBoards boards = new FakeBoards();
    final StaticListableBeanFactory beans = new StaticListableBeanFactory();
    final TeamService team;
    final TeamSearchService search;
    final AzureWritesService writes;
    final BoardItemsService boardItems;
    final CardItemsService cardItems;
    final IncomingService incoming;
    final WatchRulesService rules;
    final HookService hook;
    final PeopleService people;
    final StartService starts;
    final SeedBuilder seeds;
    final TeamTransferService transfer;
    final SavedSearchesService saved;
    final MatchService matches;

    TeamFixture(Path dir) {
        cache = new SqliteTeamCacheRepository(dir.resolve("teamboards.db"));
        live = new Live(List.of(tracker), cache, vault);
        TeamChangeSignalPort sig = new TeamChangeSignalPort() {
            @Override
            public void changed(String conn, String what) {
                signals.add(what);
            }

            @Override
            public void board(String boardId, String conn, String what, Map<String, Object> extra) {
                signals.add(what);
            }
        };
        beans.addBean("boards", boards);
        team = new TeamService(live, cache, sig, provider(HookUseCase.class));
        search = new TeamSearchService(live, cache, team, provider(TeamBoardsPort.class),
                provider(com.fathy.alfred.backend.teamboards.core.application.port.in.SavedSearchesUseCase.class));
        saved = new SavedSearchesService(cache, sig, live);
        writes = new AzureWritesService(live, cache, sig, provider(TeamBoardsPort.class), provider(CardItemsUseCase.class),
                provider(BoardItemsUseCase.class));
        Executor now = Runnable::run;
        writes.runner = now;
        boardItems = new BoardItemsService(live, cache, sig, provider(TeamBoardsPort.class), provider(AzureWritesUseCase.class),
                provider(IncomingUseCase.class), provider(TeamUseCase.class),
                provider(com.fathy.alfred.backend.teamboards.core.application.port.in.MatchesUseCase.class));
        cardItems = new CardItemsService(live, cache, sig, provider(TeamBoardsPort.class), provider(AzureWritesUseCase.class),
                provider(BoardItemsUseCase.class));
        incoming = new IncomingService(live, cache, sig, provider(TeamBoardsPort.class), provider(CardItemsUseCase.class), team);
        rules = new WatchRulesService(live, cache, sig, provider(TeamBoardsPort.class), provider(IncomingUseCase.class), search);
        hook = new HookService(live, cache, sig, provider(BoardItemsUseCase.class), provider(WatchRulesUseCase.class));
        people = new PeopleService(live, cache, team, search, provider(TeamBoardsPort.class));
        starts = new StartService(live, cache, sig, provider(TeamBoardsPort.class), provider(BoardItemsUseCase.class));
        seeds = new SeedBuilder(live, cache, provider(TeamBoardsPort.class));
        transfer = new TeamTransferService(cache, sig);
        matches = new MatchService(cache, sig, provider(TeamBoardsPort.class), provider(CardItemsUseCase.class));
        beans.addBean("matches", matches);
        beans.addBean("team", team);
        beans.addBean("writes", writes);
        beans.addBean("boardItems", boardItems);
        beans.addBean("cardItems", cardItems);
        beans.addBean("incoming", incoming);
        beans.addBean("rules", rules);
        beans.addBean("hook", hook);
        beans.addBean("saved", saved);
        cache.putConnection(new StoredConnection(CONN, "fake", "Fake", "https://t", new Scope(List.of(), List.of()), null, Instant.now()));
    }

    <T> ObjectProvider<T> provider(Class<T> type) {
        return beans.getBeanProvider(type);
    }

    TeamFixture withToken() {
        vault.put(CONN, new Token(tracker.goodToken), new com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow("p-1", "Sara Ali",
                "sara@example.com"));
        team.readLists(CONN);
        return this;
    }

    void close() {
        cache.close();
    }

    /** Boards and cards in memory. */
    static final class FakeBoards implements TeamBoardsPort {
        final Map<String, String> boardProject = new LinkedHashMap<>(Map.of("b1", "odeysys", "b2", "odeysys"));
        final Map<String, CardInfo> cards = new LinkedHashMap<>();
        final List<String> proposals = new ArrayList<>();
        final List<String> chat = new ArrayList<>();
        int next = 1;

        CardInfo card(String board, String title) {
            String id = "card-" + next;
            CardInfo c = new CardInfo(id, board, "odeysys", next++, "BUG", title, "", "TO_DO", null, Instant.now());
            cards.put(id, c);
            return c;
        }

        @Override
        public boolean projectExists(String project) {
            return boardProject.containsValue(project);
        }

        @Override
        public String whoAnswers(String project, String boardId) {
            return "the project's live runner";
        }

        @Override
        public Optional<String> projectOf(String boardId) {
            return Optional.ofNullable(boardId == null ? null : boardProject.get(boardId));
        }

        @Override
        public Optional<String> boardName(String boardId) {
            return projectOf(boardId).map(p -> "Board " + boardId);
        }

        @Override
        public Optional<Long> postStart(String project, String boardId, String text) {
            chat.add(text);
            return Optional.of((long) chat.size());
        }

        @Override
        public boolean withdrawStart(long messageId) {
            return true;
        }

        @Override
        public boolean askedBy(String askedIn) {
            return "terminal".equals(askedIn) || "msg-7".equals(askedIn);
        }

        @Override
        public Set<String> files(String boardId) {
            return Set.of();
        }

        @Override
        public String attach(String boardId, String name, byte[] data) {
            return null;
        }

        @Override
        public Optional<CardInfo> card(String cardId) {
            return Optional.ofNullable(cards.get(cardId));
        }

        @Override
        public List<Similar> similar(String boardId, String title, String text, int limit) {
            List<Similar> out = new ArrayList<>();
            for (CardInfo c : cards.values()) {
                if (c.title().equalsIgnoreCase(title)) {
                    out.add(new Similar(c, 90, "same title"));
                }
            }
            return out;
        }

        @Override
        public Optional<String> createCard(String boardId, boolean asClaude, String kind, String title, String description, String[] why) {
            CardInfo c = new CardInfo("card-" + next, boardId, "odeysys", next++, kind, title, description == null ? "" : description,
                    asClaude ? "INBOX" : "TO_DO", null);
            cards.put(c.id(), c);
            return Optional.of(c.id());
        }

        @Override
        public List<CardInfo> cardsOfBoard(String boardId, int limit) {
            List<CardInfo> out = new ArrayList<>();
            for (CardInfo c : cards.values()) {
                if (boardId.equals(c.boardId()) && !"CLOSED".equals(c.status())) {
                    out.add(0, c);
                }
            }
            return out.subList(0, Math.min(limit, out.size()));
        }

        @Override
        public boolean appendToDescription(String cardId, String text) {
            CardInfo c = cards.get(cardId);
            if (c == null) {
                return false;
            }
            cards.put(cardId, new CardInfo(c.id(), c.boardId(), c.project(), c.number(), c.kind(), c.title(),
                    (c.description() + "\n\n" + text).strip(), c.status(), c.resolution(), c.createdAt()));
            return true;
        }

        @Override
        public boolean propose(String cardId, String status, String resolution, String reason) {
            proposals.add(cardId + " " + status + " " + reason);
            return true;
        }

        final Map<String, String> boardNames = new LinkedHashMap<>();
        final List<String> made = new ArrayList<>();
        final List<String> deleted = new ArrayList<>();

        @Override
        public MadeBoard createBoard(String project, String name, FirstCycle cycle, boolean asClaude, String askedIn) {
            String id = "nb" + (made.size() + 1);
            boardProject.put(id, project);
            boardNames.put(id, name);
            made.add(id + " " + name + " " + cycle + (asClaude ? " claude" : ""));
            return new MadeBoard(id, null);
        }

        @Override
        public void deleteBoard(String boardId) {
            deleted.add(boardId);
            boardProject.remove(boardId);
            boardNames.remove(boardId);
        }

        @Override
        public Optional<String> boardNamed(String project, String name) {
            return boardNames.entrySet().stream().filter(e -> project.equals(boardProject.get(e.getKey())) && e.getValue().equalsIgnoreCase(name))
                    .map(Map.Entry::getKey).findFirst();
        }

        @Override
        public boolean proposeReopen(String cardId, String reason) {
            proposals.add(cardId + " REOPEN " + reason);
            return true;
        }
    }
}
