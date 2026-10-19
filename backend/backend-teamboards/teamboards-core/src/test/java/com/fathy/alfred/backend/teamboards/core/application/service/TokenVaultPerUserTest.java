package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/031: a paired user's tracker token is theirs alone; background work still finds a live one. */
class TokenVaultPerUserTest {

    private final AtomicReference<String> user = new AtomicReference<>();
    private final TokenVault vault = new TokenVault(Clock.systemUTC(), () -> Optional.ofNullable(user.get()));

    @Test
    void aUsersTokenIsReadOnlyByThatUser() {
        user.set("me@x.ae");
        vault.put("c1", new Token("mine"), new PersonRow("1", "Me", "me@x.ae"));
        user.set("other@x.ae");
        assertThat(vault.token("c1")).isEmpty();

        vault.put("c1", new Token("theirs"), new PersonRow("2", "Other", "other@x.ae"));
        assertThat(vault.token("c1")).get().extracting(Token::value).isEqualTo("theirs");
        user.set("Me@X.ae");
        assertThat(vault.token("c1")).get().extracting(Token::value).isEqualTo("mine");
    }

    @Test
    void ownUntilSaysOnlyWhetherTheCallersOwnTokenLives() {
        user.set(null);
        vault.put("c1", new Token("shared"), null);
        user.set("me@x.ae");
        assertThat(vault.ownUntil("c1")).isEmpty(); // the shared one is not theirs: the helper hands its own over
        vault.put("c1", new Token("mine"), null);
        assertThat(vault.ownUntil("c1")).isPresent();
        user.set(null);
        assertThat(vault.ownUntil("c1")).isEmpty();
    }

    @Test
    void aPairedUserWithoutOwnTokenStillReadsTheSharedOne() {
        user.set(null);
        vault.put("c1", new Token("shared"), null);
        user.set("me@x.ae");
        assertThat(vault.token("c1")).get().extracting(Token::value).isEqualTo("shared");
    }

    @Test
    void forgettingDropsOnlyTheCallersToken() {
        user.set("me@x.ae");
        vault.put("c1", new Token("mine"), null);
        user.set("other@x.ae");
        vault.put("c1", new Token("theirs"), null);
        vault.forget("c1");
        assertThat(vault.token("c1")).isEmpty();
        user.set("me@x.ae");
        assertThat(vault.token("c1")).isPresent();
        vault.forgetAll("c1");
        assertThat(vault.token("c1")).isEmpty();
    }

    @Test
    void backgroundWorkUsesTheNewestLiveToken() {
        user.set("me@x.ae");
        vault.put("c1", new Token("mine"), null);
        user.set(null); // no request, no user: lists and hooks
        assertThat(vault.token("c1")).get().extracting(Token::value).isEqualTo("mine");
    }
}
