package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardChangesUseCase;
import com.fathy.alfred.backend.board.application.port.in.SearchCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.VerifyFixesUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CallSignaturePort;
import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardSearchHit;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.board.domain.model.FixCheck;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.Proposal;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * What Claude reads to work across boards (docs/board.md "Claude"): a search over every board with each card's latest
 * comment, the cards that look like a finding about to be reported, everything that changed after a cursor (and a wait
 * for the next change), and the Fixed cards checked against a re-test cycle. Read-only; Claude's writes go through
 * BoardService and its limits.
 */
@Service
public class BoardInsightsService implements SearchCardsUseCase, BoardChangesUseCase, VerifyFixesUseCase {

    /** Short words that would match half the board. */
    private static final Set<String> COMMON = Set.of("with", "from", "that", "this", "when", "after", "before", "into", "then", "have",
            "does", "should", "error", "fails", "failed", "call", "calls", "page", "user", "shows", "wrong");
    private static final int MAX_WORDS = 8;

    private final BoardStorePort store;
    private final CallSignaturePort signatures;
    private final CycleCallsPort cycleCalls;
    private final BoardChangeFeed feed;

    public BoardInsightsService(BoardStorePort store, CallSignaturePort signatures, CycleCallsPort cycleCalls, BoardChangeFeed feed) {
        this.store = store;
        this.signatures = signatures;
        this.cycleCalls = cycleCalls;
        this.feed = feed;
    }

    // ----------------------------------------------------------------------------------------------------------- search

    @Override
    public SearchPage search(CardQuery query) {
        List<Card> cards = store.query(query);
        return new SearchPage(hits(cards), store.count(query));
    }

    private List<CardSearchHit> hits(List<Card> cards) {
        List<String> ids = cards.stream().map(Card::id).toList();
        Map<String, Integer> comments = store.commentCounts(ids);
        Map<String, ActivityEntry> last = store.lastComments(ids);
        Map<String, Proposal> proposals = store.proposals(ids);
        return cards.stream().map(c -> new CardSearchHit(c, comments.getOrDefault(c.id(), 0), last.get(c.id()), proposals.get(c.id())))
                .toList();
    }

    @Override
    public List<Similar> similar(String project, String title, MentionRef call, int limit) {
        int clamped = limit <= 0 ? 10 : Math.min(limit, MAX_SIMILAR);
        String signature = call == null || call.callId() == null ? null
                : signatures.signatureOf(call.direction(), call.callId(), call.cycleId()).orElse(null);
        List<String> words = words(title);
        List<Card> found = store.similar(project, signature, words, 200);
        int needed = Math.min(2, words.size());
        record Scored(Card card, boolean sameSignature, List<String> shared) {
            int score() {
                return (sameSignature ? 100 : 0) + shared.size();
            }
        }
        List<Scored> scored = new ArrayList<>();
        for (Card card : found) {
            String lower = card.title().toLowerCase(Locale.ROOT);
            List<String> shared = words.stream().filter(lower::contains).toList();
            boolean same = signature != null && signature.equals(card.signature());
            if (same || (needed > 0 && shared.size() >= needed)) {
                scored.add(new Scored(card, same, shared));
            }
        }
        scored.sort(Comparator.comparingInt(Scored::score).reversed());
        List<Scored> top = scored.subList(0, Math.min(clamped, scored.size()));
        List<CardSearchHit> asHits = hits(top.stream().map(Scored::card).toList());
        List<Similar> out = new ArrayList<>();
        for (int i = 0; i < top.size(); i++) {
            Scored s = top.get(i);
            String why = s.sameSignature() ? "same signature " + signature
                    : "title shares " + String.join(", ", s.shared());
            if (s.sameSignature() && !s.shared().isEmpty()) {
                why += "; title shares " + String.join(", ", s.shared());
            }
            out.add(new Similar(why, asHits.get(i)));
        }
        return out;
    }

    static List<String> words(String title) {
        if (title == null) {
            return List.of();
        }
        LinkedHashSet<String> out = new LinkedHashSet<>();
        for (String w : title.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}]+")) {
            if (w.length() >= 4 && !COMMON.contains(w)) {
                out.add(w);
            }
            if (out.size() == MAX_WORDS) {
                break;
            }
        }
        return List.copyOf(out);
    }

    // ---------------------------------------------------------------------------------------------------------- changes

    @Override
    public BoardChanges changes(String cursor, String project, String cycleId, Actor actor, int limit) {
        int clamped = limit <= 0 ? 200 : Math.min(limit, MAX_LIMIT);
        long afterId;
        long afterMillis;
        String c = cursor == null ? "" : cursor.strip();
        if (c.equalsIgnoreCase("now")) {
            return new BoardChanges(List.of(), List.of(), cursor(store.lastActivityId(), store.lastCycleChangeMillis()), false);
        } else if (c.equalsIgnoreCase("claude")) {
            afterId = store.lastActivityIdBy(Actor.CLAUDE, project);
            List<BoardChanges.Entry> mine = afterId == 0 ? List.of() : store.activityAfter(afterId - 1, project, null, Actor.CLAUDE, 1);
            afterMillis = mine.isEmpty() ? 0 : mine.get(0).entry().at().toEpochMilli();
        } else if (c.isEmpty()) {
            afterId = 0;
            afterMillis = 0;
        } else {
            long[] parsed = parse(c);
            afterId = parsed[0];
            afterMillis = parsed[1];
        }
        long top = store.lastActivityId(); // read first: an entry written after it is found by the next call
        List<BoardChanges.Entry> entries = store.activityAfter(afterId, project, cycleId, actor, clamped + 1);
        boolean more = entries.size() > clamped;
        if (more) {
            entries = entries.subList(0, clamped);
        }
        // Briefs, spec files and marks are the user's; suggestions are Claude's.
        List<BoardChanges.CycleChange> cycles = store.cycleChangesAfter(afterMillis, project, cycleId, clamped + 1).stream()
                .filter(x -> actor == null || (actor == Actor.CLAUDE) == x.what().equals("suggestion")).toList();
        if (cycles.size() > clamped) {
            cycles = cycles.subList(0, clamped);
            more = true;
        }
        long nextId = entries.isEmpty() ? afterId : entries.get(entries.size() - 1).entry().id();
        if (!more && entries.isEmpty()) {
            // Nothing of this actor/board: still move past what others wrote, so a wait does not wake for it again.
            nextId = Math.max(afterId, top);
        }
        long nextMillis = cycles.isEmpty() ? afterMillis : cycles.get(cycles.size() - 1).at().toEpochMilli();
        return new BoardChanges(entries, cycles, cursor(nextId, nextMillis), more);
    }

    private static String cursor(long id, long millis) {
        return id + "." + millis;
    }

    private static long[] parse(String cursor) {
        int dot = cursor.indexOf('.');
        try {
            return dot < 0 ? new long[]{Long.parseLong(cursor), 0}
                    : new long[]{Long.parseLong(cursor.substring(0, dot)), Long.parseLong(cursor.substring(dot + 1))};
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Unreadable cursor " + cursor + " - pass one a previous answer gave, \"now\" or \"claude\"");
        }
    }

    @Override
    public AutoCloseable onNextChange(Runnable listener) {
        return feed.once(listener);
    }

    // ------------------------------------------------------------------------------------------------------- fix check

    @Override
    public List<FixCheck> verify(String project, String cycleId) {
        List<CycleCall> calls = cycleCalls.calls(cycleId, MAX_CALLS);
        List<Card> fixed = store.query(new CardQuery(project, null, Set.of(), Set.of(CardStatus.FIXED), Set.of(), null, false, null, 0,
                CardQuery.MAX_LIMIT));
        List<FixCheck> out = new ArrayList<>();
        for (Card card : fixed) {
            String signature = card.signature();
            if (signature == null || !signature.contains("|")) {
                out.add(new FixCheck(card.number(), card.project(), card.title(), signature, FixCheck.Verdict.NOT_EXERCISED, List.of()));
                continue;
            }
            String endpoint = signature.substring(signature.indexOf('|') + 1);
            List<FixCheck.Seen> seen = calls.stream().filter(x -> endpoint.equals(x.endpoint()))
                    .map(x -> new FixCheck.Seen(x.ref(cycleId), label(x), x.signal())).toList();
            FixCheck.Verdict verdict = seen.isEmpty() ? FixCheck.Verdict.NOT_EXERCISED
                    : seen.stream().allMatch(s -> s.signal().equals("ok")) ? FixCheck.Verdict.LOOKS_FIXED : FixCheck.Verdict.STILL_FAILING;
            out.add(new FixCheck(card.number(), card.project(), card.title(), signature, verdict, seen));
        }
        return out;
    }

    private static String label(CycleCall call) {
        String outcome = call.status() == null ? "error" : call.status().toString();
        String label = call.method() + " " + call.path() + " · " + outcome;
        return label.length() > 200 ? label.substring(0, 199) + "…" : label;
    }
}
