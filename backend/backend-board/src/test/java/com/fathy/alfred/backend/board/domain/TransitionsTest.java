package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.CardStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import static org.assertj.core.api.Assertions.assertThat;

class TransitionsTest {

    @ParameterizedTest
    @EnumSource(value = CardStatus.class, names = "CLOSED", mode = EnumSource.Mode.EXCLUDE)
    void everyOpenStatusMovesToEveryOtherOpenStatusButNotToItselfOrClosed(CardStatus from) {
        for (CardStatus to : CardStatus.values()) {
            boolean expected = to != CardStatus.CLOSED && to != from;
            assertThat(Transitions.canMove(from, to)).as(from + " -> " + to).isEqualTo(expected);
        }
        assertThat(Transitions.canClose(from)).isTrue();
        assertThat(Transitions.canReopen(from)).isFalse();
    }

    @Test
    void aClosedCardIsLeftOnlyByReopening() {
        for (CardStatus to : CardStatus.values()) {
            assertThat(Transitions.canMove(CardStatus.CLOSED, to)).isFalse();
        }
        assertThat(Transitions.canClose(CardStatus.CLOSED)).isFalse();
        assertThat(Transitions.canReopen(CardStatus.CLOSED)).isTrue();
    }
}
