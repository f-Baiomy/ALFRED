package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/028 T005: in memory, no time limit (2026-10-20), one per connection, last entered wins, never printed. */
class TokenVaultTest {

    @Test
    void keepsTheTokenUntilForgottenOrRefusedAndTheLastOneWins() {
        AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-10-17T08:00:00Z"));
        Clock clock = new Clock() {
            @Override
            public ZoneOffset getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(java.time.ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return now.get();
            }
        };
        TokenVault v = new TokenVault(clock);
        PersonRow sara = new PersonRow("p1", "Sara", "s@x");
        PersonRow omar = new PersonRow("p2", "Omar", "o@x");
        assertThat(v.put("c", new Token("one"), sara)).isEmpty();
        assertThat(v.put("c", new Token("two"), omar)).get().isEqualTo(sara);
        assertThat(v.token("c")).get().extracting(Token::value).isEqualTo("two");
        assertThat(v.entry("c").orElseThrow().toString()).doesNotContain("two");
        now.set(now.get().plus(Duration.ofDays(30)));
        assertThat(v.token("c")).get().extracting(Token::value).isEqualTo("two"); // a month later: still held
        v.put("c", new Token("three"), sara);
        v.rejected("c", new Token("other"));
        assertThat(v.token("c")).isPresent();
        v.rejected("c", new Token("three"));
        assertThat(v.token("c")).isEmpty();
        assertThat(v.forget("c")).isFalse();
        v.put("c", new Token("four"), sara);
        assertThat(v.forget("c")).isTrue(); // Me settings ▸ Remove
        assertThat(v.token("c")).isEmpty();
    }
}
