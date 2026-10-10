package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.CardStatus;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class ClaudeRulesTest {

    @Test
    void claudeMovesWorkOnlyIntoToDoInProgressAndFixed() {
        Set<CardStatus> allowed = Set.of(CardStatus.TO_DO, CardStatus.IN_PROGRESS, CardStatus.FIXED);
        for (CardStatus to : CardStatus.values()) {
            assertThat(ClaudeRules.mayMove(CardStatus.INBOX, to)).as("INBOX -> " + to).isEqualTo(allowed.contains(to));
        }
    }

    @Test
    void claudeNeverTakesACardBackFromTheUsersColumns() {
        for (CardStatus from : Set.of(CardStatus.VERIFIED, CardStatus.DONE, CardStatus.CLOSED)) {
            assertThat(ClaudeRules.mayMove(from, CardStatus.IN_PROGRESS)).as(from.name()).isFalse();
        }
    }
}
