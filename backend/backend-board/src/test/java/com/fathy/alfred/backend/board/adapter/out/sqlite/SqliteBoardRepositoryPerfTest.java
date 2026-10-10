package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import com.fathy.alfred.backend.board.domain.model.Scope;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SC-005: a board of 2,000 cards opens and filters in under a second. Each card carries a 4 KB description, five
 * history entries and two mentions, so the list query has real rows to skip past (it must not read descriptions).
 */
class SqliteBoardRepositoryPerfTest {

    @TempDir
    Path dir;

    @Test
    void twoThousandCardsOpenAndFilterInUnderASecond() {
        SqliteBoardRepository repo = new SqliteBoardRepository(JsonMapper.builder().findAndAddModules().build(),
                dir.resolve("board.db").toString());
        repo.init();
        try {
            String description = "x".repeat(4096);
            CardStatus[] statuses = CardStatus.values();
            for (int i = 0; i < 2000; i++) {
                Instant at = Instant.parse("2026-10-01T00:00:00Z").plusSeconds(i);
                Card c = new Card(UUID.randomUUID().toString(), "p", repo.nextNumber("p"), i % 3 == 0 ? CardKind.BUG : CardKind.TASK,
                        "card " + i, description, statuses[i % statuses.length], i % statuses.length == 6
                        ? com.fathy.alfred.backend.board.domain.model.Resolution.FINE : null, null,
                        i % 5 == 0 ? Set.of(Flag.URGENT) : Set.of(), Scope.NOT_DECIDED, Actor.USER, "c-" + (i % 20), false,
                        null, at, at, Actor.USER);
                repo.insert(c);
                for (int e = 0; e < 5; e++) {
                    repo.append(new ActivityEntry(0, c.id(), Actor.USER, ActivityKind.COMMENT, "comment " + e, null, null, at));
                }
                repo.replaceMentions(MentionOwner.CARD, c.id(), c.id(), List.of(new MentionRef(MentionType.CALL, "in:call" + i, "POST"),
                        new MentionRef(MentionType.CYCLE, "c-1", "cycle")));
            }

            long start = System.nanoTime();
            List<Card> page = repo.query(new CardQuery("p", null, null, null, null, null, false, null, 0, 500));
            List<String> ids = page.stream().map(Card::id).toList();
            repo.commentCounts(ids);
            repo.chipsOf(ids, 3);
            repo.count(new CardQuery("p", null, null, null, null, null, false, null, 0, 500));
            repo.progress("p", null);
            long open = System.nanoTime() - start;

            start = System.nanoTime();
            int filtered = repo.count(new CardQuery("p", null, Set.of(CardKind.BUG), null, Set.of(Flag.URGENT), null, false, "card 1", 0, 500));
            repo.query(new CardQuery("p", null, Set.of(CardKind.BUG), null, Set.of(Flag.URGENT), null, false, "card 1", 0, 500));
            long filter = System.nanoTime() - start;

            System.out.printf("board perf: 2000 cards - open %d ms, filter %d ms (%d match)%n", open / 1_000_000, filter / 1_000_000, filtered);
            assertThat(page).hasSize(500);
            assertThat(open).isLessThan(1_000_000_000L);
            assertThat(filter).isLessThan(1_000_000_000L);
        } finally {
            repo.close();
        }
    }
}
