package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase.Markers;
import com.fathy.alfred.backend.teamboards.core.application.port.in.MatchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardItem;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MatchState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MAIN;

/**
 * Card matches by code (specs/030 D5): each open card of the board that links no item, against the open Bug/Task/Issue
 * items of the board's tree that no card of the board links and that were not made before the card. Score = the share of the smaller word set the two texts
 * share, plus {@link #PATH_SCORE} for each endpoint path both name. A REJECTED or LINKED row is never re-proposed; a
 * proposal whose card or item no longer qualifies goes.
 */
@Service
public class MatchService implements MatchesUseCase {

    static final double PROPOSE_AT = 0.3;
    static final int MIN_SHARED = 2;
    static final double PATH_SCORE = 0.5;
    static final int MAX_PER_CARD = 5;
    static final int MAX_WHY = 2000;
    static final Set<String> TYPES = Set.of("bug", "task", "issue");
    static final Set<String> STOP = Set.of("the", "and", "for", "with", "that", "this", "from", "into", "when", "not", "are", "was", "were",
            "has", "have", "had", "but", "all", "any", "can", "should", "must", "will", "its", "out", "our", "you", "your", "then", "than", "there",
            "their", "they", "them", "what", "which", "who", "why", "how", "after", "before", "also", "only", "same", "each", "both", "one", "two",
            "new", "via", "per", "does", "did", "get", "set", "use", "used", "user", "card", "item", "bug", "task", "issue", "nbsp", "div", "span",
            "http", "https", "www", "com", "call");
    static final Pattern WORD = Pattern.compile("[\\p{L}\\p{N}_]+");
    static final Pattern PATH = Pattern.compile("/api/[A-Za-z0-9_\\-./{}]+");
    static final Pattern TAG = Pattern.compile("<[^>]+>");

    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<CardItemsUseCase> cardItems;
    private final Clock clock = Clock.systemUTC();

    public MatchService(TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                        ObjectProvider<CardItemsUseCase> cardItems) {
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.cardItems = cardItems;
    }

    // ------------------------------------------------------------------------------------------------------ propose

    @Override
    public int propose(String boardId, Map<String, Item> read) {
        TeamBoardsPort p = boards.getIfAvailable();
        if (p == null || boardId == null) {
            return 0;
        }
        List<CardLinkRow> links = cache.cardLinksOfBoard(boardId);
        Set<String> linkedCards = new HashSet<>();
        Set<String> linkedItems = new HashSet<>();
        for (CardLinkRow l : links) {
            linkedCards.add(l.cardId());
            linkedItems.add(l.conn() + "/" + l.item());
        }
        List<BoardItemRow> candidates = new ArrayList<>();
        for (BoardItemRow r : cache.boardItems(boardId)) {
            if (!MAIN.equals(r.role()) && r.leftTreeAt() == null && r.type() != null && TYPES.contains(r.type().toLowerCase(Locale.ROOT))
                    && !Live.closed(r.stateCategory()) && !linkedItems.contains(r.conn() + "/" + r.item())) {
                candidates.add(r);
            }
        }
        Map<String, Text> itemText = new HashMap<>();
        Map<String, Instant> created = new HashMap<>();
        for (BoardItemRow r : candidates) {
            String k = r.conn() + "/" + r.item();
            Optional<Item> full = Optional.ofNullable(read.get(k)).or(() -> cache.copy(r.conn(), r.item()).flatMap(Copies::item));
            itemText.put(k, text(itemTextOf(r, full.orElse(null))));
            full.map(MatchService::createdOf).ifPresent(at -> created.put(k, at));
        }
        Map<String, MatchRow> old = new HashMap<>();
        for (MatchRow m : cache.matchesOfBoard(boardId)) {
            old.put(key(m.cardId(), m.conn(), m.item()), m);
        }
        Set<String> fresh = new HashSet<>();
        for (CardInfo card : p.cardsOfBoard(boardId, 500)) {
            if (linkedCards.contains(card.id())) {
                continue;
            }
            Text ct = text((card.title() == null ? "" : card.title()) + "\n" + (card.description() == null ? "" : card.description()));
            List<MatchRow> found = new ArrayList<>();
            for (BoardItemRow r : candidates) {
                Instant at = created.get(r.conn() + "/" + r.item());
                if (at != null && card.createdAt() != null && at.isBefore(card.createdAt())) {
                    continue; // made before the card: not the item filed for it
                }
                Text it = itemText.get(r.conn() + "/" + r.item());
                Scored s = score(ct, it);
                if (s == null) {
                    continue;
                }
                found.add(new MatchRow(boardId, card.id(), r.conn(), r.item(), MatchState.PROPOSED, s.why(), s.score(), clock.instant()));
            }
            found.sort((a, b) -> Double.compare(b.score(), a.score()));
            for (MatchRow m : found.subList(0, Math.min(MAX_PER_CARD, found.size()))) {
                String k = key(m.cardId(), m.conn(), m.item());
                MatchRow was = old.get(k);
                if (was != null && was.state() != MatchState.PROPOSED) {
                    continue; // rejected or linked: never again
                }
                fresh.add(k);
                if (was == null) {
                    cache.putMatch(m);
                } else if (Math.abs(was.score() - m.score()) > 1e-9) {
                    // the score moves; a reason Claude wrote stays
                    cache.putMatch(new MatchRow(boardId, m.cardId(), m.conn(), m.item(), MatchState.PROPOSED, was.why(), m.score(), was.at()));
                }
            }
        }
        int proposed = 0;
        for (Map.Entry<String, MatchRow> e : old.entrySet()) {
            MatchRow m = e.getValue();
            if (m.state() == MatchState.PROPOSED && !fresh.contains(e.getKey())) {
                cache.deleteMatch(m.cardId(), m.conn(), m.item());
            }
        }
        for (MatchRow m : cache.matchesOfBoard(boardId)) {
            if (m.state() == MatchState.PROPOSED) {
                proposed++;
            }
        }
        return proposed;
    }

    /** When the tracker made the item (Azure's System.CreatedDate), or null when unknown. */
    static Instant createdOf(Item i) {
        String v = i.fields().get("System.CreatedDate");
        try {
            return v == null || v.isBlank() ? null : Instant.parse(v.strip());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private String itemTextOf(BoardItemRow r, Item full) {
        StringBuilder sb = new StringBuilder(r.title() == null ? "" : r.title());
        Optional.ofNullable(full).ifPresent(i -> {
            for (String f : List.of("System.Description", "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.Common.AcceptanceCriteria")) {
                String v = i.fields().get(f);
                if (v != null) {
                    sb.append('\n').append(v);
                }
            }
        });
        return sb.toString();
    }

    record Text(Set<String> words, Set<String> paths) {
    }

    record Scored(double score, String why) {
    }

    static Text text(String raw) {
        String s = TAG.matcher(raw == null ? "" : raw).replaceAll(" ");
        Set<String> paths = new LinkedHashSet<>();
        Matcher pm = PATH.matcher(s);
        while (pm.find()) {
            paths.add(normalPath(pm.group()));
        }
        Set<String> words = new LinkedHashSet<>();
        Matcher wm = WORD.matcher(s.toLowerCase(Locale.ROOT));
        while (wm.find()) {
            String w = wm.group();
            if (w.length() >= 3 && !STOP.contains(w) && !w.chars().allMatch(Character::isDigit)) {
                words.add(w);
            }
        }
        return new Text(words, paths);
    }

    /** "/api/orders/123/" and "/api/orders/{id}" name the same endpoint. */
    static String normalPath(String p) {
        String s = p.toLowerCase(Locale.ROOT).replaceAll("[.,;:)]+$", "").replaceAll("/+$", "");
        return s.replaceAll("/(\\d+|\\{[^}/]*})(?=/|$)", "/{id}");
    }

    static Scored score(Text card, Text item) {
        if (card.words().isEmpty() || item.words().isEmpty()) {
            return null;
        }
        List<String> shared = new ArrayList<>();
        for (String w : card.words()) {
            if (item.words().contains(w)) {
                shared.add(w);
            }
        }
        List<String> paths = new ArrayList<>();
        for (String p : card.paths()) {
            if (item.paths().contains(p)) {
                paths.add(p);
            }
        }
        double score = (double) shared.size() / Math.min(card.words().size(), item.words().size()) + PATH_SCORE * paths.size();
        boolean byWords = shared.size() >= MIN_SHARED && score >= PROPOSE_AT;
        if (!byWords && paths.isEmpty()) {
            return null;
        }
        StringBuilder why = new StringBuilder();
        if (!paths.isEmpty()) {
            why.append("same endpoint ").append(String.join(", ", paths));
        }
        if (!shared.isEmpty()) {
            if (!why.isEmpty()) {
                why.append("; ");
            }
            why.append("shared words: ").append(String.join(", ", shared.subList(0, Math.min(8, shared.size()))));
        }
        return new Scored(Math.round(score * 100) / 100.0, why.toString());
    }

    // ------------------------------------------------------------------------------------------------------ actions

    @Override
    public List<Match> matches(String cardId) {
        List<Match> out = new ArrayList<>();
        Map<String, List<BoardItemRow>> rows = new HashMap<>();
        for (MatchRow m : cache.matchesOfCard(cardId)) {
            if (m.state() != MatchState.PROPOSED) {
                continue;
            }
            Optional<BoardItemRow> row = rows.computeIfAbsent(m.boardId(), cache::boardItems).stream()
                    .filter(x -> x.conn().equals(m.conn()) && x.item().equals(m.item())).findFirst();
            out.add(new Match(m, row.map(BoardItemRow::type).orElse(null), row.map(BoardItemRow::title).orElse("Item " + m.item()),
                    row.map(BoardItemRow::state).orElse(null)));
        }
        return out;
    }

    private MatchRow proposed(String cardId, String conn, String item) {
        return cache.match(cardId, conn, item).filter(m -> m.state() == MatchState.PROPOSED)
                .orElseThrow(() -> TeamException.notFound("Card " + cardId + " has no proposed match " + conn + "/" + item));
    }

    @Override
    public List<CardItem> link(Who who, String cardId, String conn, String item) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user links a card to a proposed item");
        }
        MatchRow m = proposed(cardId, conn, item);
        CardItemsUseCase ci = cardItems.getIfAvailable();
        if (ci == null) {
            throw TeamException.notFound("Card links are not wired in this Alfred");
        }
        List<CardItem> items = ci.link(Who.USER, cardId, conn, item, Markers.NONE, null).items();
        cache.putMatch(new MatchRow(m.boardId(), cardId, conn, item, MatchState.LINKED, m.why(), m.score(), clock.instant()));
        for (MatchRow o : cache.matchesOfBoard(m.boardId())) {
            if (o.state() != MatchState.PROPOSED) {
                continue;
            }
            boolean sameItem = o.conn().equals(conn) && o.item().equals(item);
            if (sameItem || o.cardId().equals(cardId)) {
                cache.deleteMatch(o.cardId(), o.conn(), o.item()); // the item is taken; the card is linked
            }
        }
        signals.board(m.boardId(), conn, "matches", Map.of("card", cardId));
        return items;
    }

    @Override
    public List<Match> reject(Who who, String cardId, String conn, String item) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user rejects a proposed item");
        }
        MatchRow m = proposed(cardId, conn, item);
        cache.putMatch(new MatchRow(m.boardId(), cardId, conn, item, MatchState.REJECTED, m.why(), m.score(), clock.instant()));
        signals.board(m.boardId(), conn, "matches", Map.of("card", cardId));
        return matches(cardId);
    }

    @Override
    public List<Match> why(String cardId, String conn, String item, String why) {
        String w = why == null ? "" : why.strip();
        if (w.isEmpty() || w.length() > MAX_WHY) {
            throw TeamException.invalid("A reason of 1 to " + MAX_WHY + " characters");
        }
        MatchRow m = proposed(cardId, conn, item);
        cache.putMatch(new MatchRow(m.boardId(), cardId, conn, item, MatchState.PROPOSED, w, m.score(), m.at()));
        signals.board(m.boardId(), conn, "matches", Map.of("card", cardId));
        return matches(cardId);
    }

    private static String key(String card, String conn, String item) {
        return card + "|" + conn + "|" + item;
    }
}
