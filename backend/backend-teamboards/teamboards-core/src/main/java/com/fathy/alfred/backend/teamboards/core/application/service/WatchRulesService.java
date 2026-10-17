package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.IncomingUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.application.port.in.WatchRulesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WatchRuleRow;
import com.fathy.alfred.backend.teamboards.spi.ItemSearcher;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Clock;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Watch rules (specs/028 US5). A rule reads at most 200 matches a run; what is already on the board or linked is skipped. */
@Service
public class WatchRulesService implements WatchRulesUseCase {

    private static final Logger log = LoggerFactory.getLogger(WatchRulesService.class);
    static final int MAX_MATCHES = 200;

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<IncomingUseCase> incoming;
    private final TeamSearchService search;
    private final Clock clock = Clock.systemUTC();

    public WatchRulesService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                             ObjectProvider<IncomingUseCase> incoming, TeamSearchService search) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.incoming = incoming;
        this.search = search;
    }

    @Override
    public List<WatchRuleRow> rules(String boardId) {
        return cache.rules(boardId);
    }

    @Override
    public WatchRuleRow put(String boardId, Long id, String conn, String name, SearchIn query) {
        TeamBoardsPort p = boards.getIfAvailable();
        if (p == null || p.projectOf(boardId).isEmpty()) {
            throw TeamException.notFound("No board " + boardId);
        }
        live.stored(conn);
        if (name == null || name.isBlank() || name.length() > 120) {
            throw TeamException.invalid("A rule's name is 1 to 120 characters");
        }
        if (query == null) {
            throw TeamException.invalid("A rule holds a search");
        }
        if (id == null && cache.rules(boardId).size() >= MAX_RULES) {
            throw TeamException.invalid("A board has at most " + MAX_RULES + " watch rules");
        }
        if (id != null) {
            long want = id;
            cache.rule(want).filter(r -> r.boardId().equals(boardId)).orElseThrow(() -> TeamException.notFound("No rule " + want));
        }
        String json;
        try {
            json = Copies.JSON.writeValueAsString(query);
        } catch (IOException e) {
            throw TeamException.invalid("The search could not be saved");
        }
        WatchRuleRow saved = cache.putRule(new WatchRuleRow(id == null ? 0 : id, boardId, conn, name.strip(), json, clock.instant(), null, null, 0));
        signals.board(boardId, conn, "rules", Map.of());
        return saved;
    }

    @Override
    public boolean delete(String boardId, long id) {
        boolean ours = cache.rule(id).filter(r -> r.boardId().equals(boardId)).isPresent();
        boolean gone = ours && cache.deleteRule(id);
        if (gone) {
            signals.board(boardId, null, "rules", Map.of());
        }
        return gone;
    }

    @Override
    public int run(String boardId, String source) {
        int found = 0;
        for (WatchRuleRow r : cache.rules(boardId)) {
            found += runOne(r, source);
        }
        return found;
    }

    @Override
    public int runForConnection(String conn, String source) {
        int found = 0;
        for (WatchRuleRow r : cache.rulesOfConnection(conn)) {
            try {
                found += runOne(r, source);
            } catch (TeamException e) {
                log.info("Watch rule {} not run: {}", r.id(), e.code());
            }
        }
        return found;
    }

    int runOne(WatchRuleRow r, String source) {
        SearchIn in;
        try {
            in = Copies.JSON.readValue(r.queryJson(), SearchIn.class);
        } catch (IOException e) {
            throw TeamException.invalid("Rule " + r.name() + " holds a search this Alfred cannot read");
        }
        Ctx c = live.ctx(r.conn());
        ItemSearcher s = live.cap(c, ItemSearcher.class, "search");
        Set<String> onBoard = new LinkedHashSet<>();
        cache.boardItems(r.boardId()).forEach(b -> onBoard.add(b.conn() + "/" + b.item()));
        cache.cardLinksOfBoard(r.boardId()).forEach(b -> onBoard.add(b.conn() + "/" + b.item()));
        IncomingUseCase in2 = incoming.getIfAvailable();
        int found = 0;
        int seen = 0;
        for (int page = 0; seen < MAX_MATCHES; page++) {
            SearchIn paged = new SearchIn(in.text(), in.types(), in.states(), in.openOnly(), in.areas(), in.teams(), in.iterations(), in.assigned(),
                    in.createdBy(), in.changedWithinDays(), in.tags(), in.parent(), in.mine(), in.sort(), page, ItemQuery.MAX_PAGE_SIZE);
            ItemQuery q = search.query(r.conn(), paged);
            ItemPage got = live.call(c, () -> s.search(c.connection(), c.token(), q));
            for (Item i : got.items()) {
                seen++;
                if (!onBoard.contains(r.conn() + "/" + i.extId()) && in2 != null && in2.arrive(r.boardId(), r.conn(), i, IncomingSource.RULE)) {
                    found++;
                }
            }
            if (got.items().size() < ItemQuery.MAX_PAGE_SIZE || seen >= got.total()) {
                break;
            }
        }
        cache.markRuleRun(r.id(), clock.instant(), source, found);
        signals.board(r.boardId(), r.conn(), "rules", Map.of("new", found));
        return found;
    }
}
