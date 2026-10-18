package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.domain.model.Caller;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class PcTokenServiceTest {

    @TempDir
    Path dir;

    private SessionsFixture f;
    private PcTokenService tokens;

    @BeforeEach
    void setUp() {
        f = new SessionsFixture(dir);
        tokens = new PcTokenService(f.keys, f.clock);
    }

    @Test
    void aTokenEnteredInABrowserReachesTheChosenPcOnceAndNoOtherOne() {
        Caller pc = f.helper("me@x.ae", "WORK-PC");
        Caller laptop = f.helper("me@x.ae", "LAPTOP");
        Caller browser = f.browser(pc);

        assertThat(tokens.send(browser, pc.keyId(), " pat-123 ")).isTrue();

        assertThat(tokens.take(laptop)).isEmpty();
        assertThat(tokens.take(browser)).isEmpty(); // only a helper takes it
        assertThat(tokens.take(pc)).contains("pat-123");
        assertThat(tokens.take(pc)).isEmpty();
    }

    @Test
    void onlyToTheUsersOwnPcAndNotForever() {
        Caller mine = f.helper("me@x.ae", "WORK-PC");
        Caller theirs = f.helper("ahmed@x.ae", "DEV");
        Caller browser = f.browser(mine);

        assertThat(tokens.send(browser, theirs.keyId(), "pat")).isFalse();
        assertThat(tokens.take(theirs)).isEmpty();

        tokens.send(browser, mine.keyId(), "pat");
        f.clock.plusMinutes(PcTokenService.LIFE.toMinutes() + 1);
        assertThat(tokens.take(mine)).isEmpty();
    }

    @Test
    void forgettingIsSentTheSameWay() {
        Caller pc = f.helper("me@x.ae", "WORK-PC");
        tokens.send(f.browser(pc), pc.keyId(), null);
        assertThat(tokens.take(pc)).contains("");
    }
}
