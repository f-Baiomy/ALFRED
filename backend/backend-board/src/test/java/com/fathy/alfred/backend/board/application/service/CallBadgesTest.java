package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CallBadgesTest {

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

    @Test
    void aCycleShowsTheCardsThatMentionItsCalls() {
        String id = f.board.create(Actor.USER, new CreateCardUseCase.NewCard("p", CardKind.BUG, "discount", "@[call:in:k1@c-1|POST]",
                Set.of(), "c-1", null, List.of())).card().card().id();
        f.board.move(Actor.USER, id, CardStatus.IN_PROGRESS);

        List<CallBadge> badges = f.board.badgesOfCycle("c-1").get("k1");

        assertThat(badges).singleElement().satisfies(b -> {
            assertThat(b.number()).isEqualTo(1);
            assertThat(b.status()).isEqualTo(CardStatus.IN_PROGRESS);
        });
        f.board.delete(Actor.USER, id);
        assertThat(f.board.badgesOfCycle("c-1")).isEmpty();
    }

    @Test
    void liveCallsAskForAtMostAHundredIds() {
        f.add(Actor.USER, "p", CardKind.BUG, "t", "@[call:in:L1|GET]");

        assertThat(f.board.badgesOfCalls(List.of("L1", "L2"))).containsOnlyKeys("L1");
        assertThatThrownBy(() -> f.board.badgesOfCalls(Collections.nCopies(101, "x"))).isInstanceOf(IllegalArgumentException.class);
    }
}
