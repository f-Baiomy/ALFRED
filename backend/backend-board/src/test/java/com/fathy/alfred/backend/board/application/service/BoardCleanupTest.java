package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardStorageUseCase;
import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.DeleteCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardStorage;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Cleaning up after a deleted cycle: its cards with it, leftover cards in bulk, and compacting board.db. */
class BoardCleanupTest {

    @TempDir
    Path dir;
    private BoardFixture f;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private String cycleCard(String cycleId, String title) {
        CardChange c = f.board.create(Actor.USER, new CreateCardUseCase.NewCard("p", CardKind.BUG, title, "", Set.of(), cycleId, null, List.of()));
        assertThat(c.outcome()).as(c.message()).isEqualTo(CardChange.Outcome.OK);
        return c.card().card().id();
    }

    private CardQuery deletedCycleCards() {
        return new CardQuery("p", null, Set.of(), Set.of(), Set.of(), null, false, null, 0, 100, false, null, false, null, true);
    }

    @Test
    void deletingACycleWithItsCardsRemovesOnlyThatCyclesCards() {
        cycleCard("c1", "a");
        cycleCard("c1", "b");
        String other = cycleCard("c2", "c");
        f.signals.clear();

        DeleteCardUseCase.CycleCardsDeleted out = f.board.deleteCycleCards(Actor.USER, "c1");

        assertThat(out.deleted()).isEqualTo(2);
        assertThat(f.store.cardIdsOfCycle("c1")).isEmpty();
        assertThat(f.store.find(other)).isPresent();
        assertThat(f.signals).containsExactly("deleted:p:c1");
        assertThat(f.board.deleteCycleCards(Actor.CLAUDE, "c2").outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void cardsKeptAfterTheirCycleWasDeletedCanBeFoundAndDeletedInBulk() {
        String a = cycleCard("c1", "a");
        String b = cycleCard("c1", "b");
        cycleCard("c2", "kept");
        f.briefs.cycleRemoved("c1");

        assertThat(f.board.query(deletedCycleCards()).cards()).hasSize(2);

        BulkCardsUseCase.BulkOutcome out = f.board.bulk(Actor.USER, List.of(a, b), BulkCardsUseCase.Action.DELETE, null);
        assertThat(out.updated()).isEqualTo(2);
        assertThat(f.board.query(deletedCycleCards()).cards()).isEmpty();
        assertThat(f.board.bulk(Actor.CLAUDE, List.of(a), BulkCardsUseCase.Action.DELETE, null).outcome())
                .isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
    }

    @Test
    void compactingGivesTheFreeSpaceBackAndOnlyTheUserMayDoIt() {
        BoardStorageService storage = new BoardStorageService(f.store);
        String big = "x".repeat(200_000);
        for (int i = 0; i < 20; i++) {
            f.briefs.putBrief(Actor.USER, "c" + i, big + i);
        }
        for (int i = 0; i < 20; i++) {
            f.briefs.cycleRemoved("c" + i);
        }
        BoardStorage before = storage.storage();
        assertThat(before.freeBytes()).isGreaterThan(1_000_000);

        assertThat(storage.compact(Actor.CLAUDE).outcome()).isEqualTo(CardChange.Outcome.REFUSED_FOR_CLAUDE);
        BoardStorageUseCase.Compacted out = storage.compact(Actor.USER);
        assertThat(out.outcome()).isEqualTo(CardChange.Outcome.OK);
        assertThat(out.after().freeBytes()).isZero();
        assertThat(out.after().fileBytes()).isLessThan(out.before().fileBytes());
    }
}
