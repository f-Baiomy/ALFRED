package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamTransferUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WatchRuleRow;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Writes a board's tracker side into its export and reads it back (specs/028 FR-112). Copies travel whole - never cut - so
 * an imported board shows its main and card items before the first sync. Of a card's matches only the rejected ones
 * travel (by card number, like card links), so an imported board never proposes them again; proposals are found anew.
 */
@Service
public class TeamTransferService implements TeamTransferUseCase {

    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final Clock clock;

    @Autowired
    public TeamTransferService(TeamCachePort cache, TeamChangeSignalPort signals) {
        this(cache, signals, Clock.systemUTC());
    }

    TeamTransferService(TeamCachePort cache, TeamChangeSignalPort signals, Clock clock) {
        this.cache = cache;
        this.signals = signals;
        this.clock = clock;
    }

    @Override
    public List<TeamRecord> export(String boardId) {
        List<TeamRecord> out = new ArrayList<>();
        Set<String> copied = new HashSet<>();
        for (BoardItemRow r : cache.boardItems(boardId)) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("boardId", r.boardId());
            f.put("conn", r.conn());
            f.put("item", r.item());
            f.put("role", r.role());
            f.put("relation", r.relation());
            put(f, "linkKind", r.linkKind());
            put(f, "parent", r.parent());
            f.put("depth", r.depth());
            put(f, "type", r.type());
            put(f, "title", r.title());
            put(f, "state", r.state());
            put(f, "stateCategory", r.stateCategory());
            f.put("rev", r.rev());
            put(f, "leftTreeAt", r.leftTreeAt());
            put(f, "addedAt", r.addedAt());
            put(f, "addedBy", r.addedBy());
            if (!"REF".equals(r.role()) && copied.add(r.conn() + "/" + r.item())) {
                cache.copy(r.conn(), r.item()).ifPresent(c -> f.put("copy", copy(c)));
            }
            out.add(new TeamRecord(ITEM, f));
        }
        for (CardLinkRow l : cache.cardLinksOfBoard(boardId)) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("cardId", l.cardId());
            put(f, "boardId", l.boardId());
            f.put("conn", l.conn());
            f.put("item", l.item());
            put(f, "linkedAt", l.linkedAt());
            put(f, "linkedBy", l.linkedBy());
            f.put("hyperlink", l.hyperlink());
            f.put("tag", l.tag());
            put(f, "commentId", l.commentId());
            if (copied.add(l.conn() + "/" + l.item())) {
                cache.copy(l.conn(), l.item()).ifPresent(c -> f.put("copy", copy(c)));
            }
            out.add(new TeamRecord(CARD_LINK, f));
        }
        for (MatchRow m : cache.matchesOfBoard(boardId)) {
            if (m.state() != MatchState.REJECTED) {
                continue;
            }
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("cardId", m.cardId());
            f.put("boardId", m.boardId());
            f.put("conn", m.conn());
            f.put("item", m.item());
            f.put("state", m.state().name());
            put(f, "why", m.why());
            f.put("score", m.score());
            put(f, "at", m.at());
            out.add(new TeamRecord(CARD_MATCH, f));
        }
        for (IncomingRow i : cache.incoming(boardId, IncomingState.WAITING)) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("boardId", i.boardId());
            f.put("conn", i.conn());
            f.put("item", i.item());
            f.put("source", i.source().name());
            put(f, "arrivedAt", i.arrivedAt());
            f.put("rev", i.rev());
            put(f, "type", i.type());
            put(f, "title", i.title());
            out.add(new TeamRecord(INCOMING, f));
        }
        for (WatchRuleRow r : cache.rules(boardId)) {
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("boardId", r.boardId());
            f.put("conn", r.conn());
            f.put("name", r.name());
            f.put("queryJson", r.queryJson());
            out.add(new TeamRecord(RULE, f));
        }
        return out;
    }

    private static Map<String, Object> copy(ItemCopyRow c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("rev", c.rev());
        m.put("itemJson", c.itemJson());
        put(m, "commentsJson", c.commentsJson());
        put(m, "savedAt", c.savedAt());
        return m;
    }

    private static void put(Map<String, Object> m, String k, Object v) {
        if (v != null) {
            m.put(k, v instanceof Instant i ? i.toString() : v);
        }
    }

    @Override
    public boolean importRecord(String kind, String boardId, String cardId, Map<String, Object> f) {
        String conn = text(f, "conn");
        String item = text(f, "item");
        if (boardId == null || conn == null || item == null || cache.connection(conn).isEmpty()) {
            return false;
        }
        Instant now = clock.instant();
        switch (kind) {
            case ITEM -> {
                String role = Optional.ofNullable(text(f, "role")).filter(r -> Set.of("MAIN", "CARD", "REF").contains(r)).orElse("REF");
                if ("MAIN".equals(role) && cache.main(boardId).filter(m -> !(m.conn().equals(conn) && m.item().equals(item))).isPresent()) {
                    role = "REF"; // the board here already has another main
                }
                cache.putBoardItem(new BoardItemRow(boardId, conn, item, role, Optional.ofNullable(text(f, "relation")).orElse("ADDED"), text(f, "linkKind"),
                        text(f, "parent"), number(f, "depth"), text(f, "type"), text(f, "title"), text(f, "state"), text(f, "stateCategory"),
                        number(f, "rev"), instant(f, "leftTreeAt"), Optional.ofNullable(instant(f, "addedAt")).orElse(now),
                        Optional.ofNullable(text(f, "addedBy")).orElse("USER")));
                putCopy(conn, item, f.get("copy"));
            }
            case CARD_LINK -> {
                if (cardId == null) {
                    return false;
                }
                cache.putCardLink(new CardLinkRow(cardId, boardId, conn, item, Optional.ofNullable(instant(f, "linkedAt")).orElse(now),
                        Optional.ofNullable(text(f, "linkedBy")).orElse("USER"), Boolean.TRUE.equals(f.get("hyperlink")), Boolean.TRUE.equals(f.get("tag")),
                        text(f, "commentId")));
                putCopy(conn, item, f.get("copy"));
            }
            case CARD_MATCH -> {
                if (cardId == null) {
                    return false;
                }
                double score = f.get("score") instanceof Number n ? n.doubleValue() : 0;
                cache.putMatch(new MatchRow(boardId, cardId, conn, item, MatchState.REJECTED, text(f, "why"), score,
                        Optional.ofNullable(instant(f, "at")).orElse(now)));
            }
            case INCOMING -> {
                IncomingSource source;
                try {
                    source = IncomingSource.valueOf(Optional.ofNullable(text(f, "source")).orElse("HAND"));
                } catch (IllegalArgumentException e) {
                    source = IncomingSource.HAND;
                }
                cache.arrive(new IncomingRow(boardId, conn, item, source, Optional.ofNullable(instant(f, "arrivedAt")).orElse(now), number(f, "rev"),
                        text(f, "type"), text(f, "title"), null, null, null, null, null, IncomingState.WAITING, null));
            }
            case RULE -> {
                String name = text(f, "name");
                String query = text(f, "queryJson");
                if (name == null || query == null || cache.rules(boardId).stream().anyMatch(r -> r.name().equals(name) && r.conn().equals(conn))) {
                    return false;
                }
                cache.putRule(new WatchRuleRow(0, boardId, conn, name, query, now, null, null, 0));
            }
            default -> {
                return false;
            }
        }
        signals.board(boardId, conn, "items", Map.of());
        return true;
    }

    @SuppressWarnings("unchecked")
    private void putCopy(String conn, String item, Object copy) {
        if (!(copy instanceof Map<?, ?> m) || cache.copy(conn, item).isPresent()) {
            return; // a copy here is newer or the same item; never overwritten by an older file
        }
        Map<String, Object> c = (Map<String, Object>) m;
        String json = text(c, "itemJson");
        if (json == null) {
            return;
        }
        cache.putCopy(new ItemCopyRow(conn, item, number(c, "rev"), json, text(c, "commentsJson"),
                Optional.ofNullable(instant(c, "savedAt")).orElse(clock.instant())));
    }

    private static String text(Map<String, Object> f, String k) {
        Object v = f.get(k);
        return v == null ? null : String.valueOf(v);
    }

    private static int number(Map<String, Object> f, String k) {
        Object v = f.get(k);
        if (v instanceof Number n) {
            return n.intValue();
        }
        try {
            return v == null ? 0 : Integer.parseInt(String.valueOf(v));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static Instant instant(Map<String, Object> f, String k) {
        String v = text(f, k);
        try {
            return v == null ? null : Instant.parse(v);
        } catch (RuntimeException e) {
            return null;
        }
    }
}
