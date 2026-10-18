package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.SessionsUseCase;
import com.fathy.alfred.backend.sessions.domain.model.BoardSession;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.HelperCommand;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionsServiceTest {

    @TempDir
    Path dir;

    private SessionsFixture f;
    private Caller me;
    private Caller other;

    @BeforeEach
    void setUp() {
        f = new SessionsFixture(dir);
        me = f.helper("me@x.ae", "WORK-PC");
        other = f.helper("o@x.ae", "PC2");
    }

    private SessionsUseCase.Report report(String board, String cli) {
        return new SessionsUseCase.Report(null, board, "odeysys", cli, "local_" + cli, "C:/wt/" + board, "AB#1 " + board,
                BoardSession.State.ANSWERING, BoardSession.OpenIn.NONE, 3L, 1200L, null);
    }

    @Test
    void theFirstSessionOfABoardIsItsCurrentOneAndALaterOneOnlyWhenAsked() {
        BoardSession a = f.sessions.report(me, report("b1", "cli-a"));
        BoardSession b = f.sessions.report(me, report("b1", "cli-b"));

        assertThat(f.sessions.current("b1")).get().extracting(BoardSession::id).isEqualTo(a.id());
        f.sessions.report(me, new SessionsUseCase.Report(b.id(), "b1", null, "cli-b", null, null, null, null, null, null, null, true));
        assertThat(f.sessions.current("b1")).get().extracting(BoardSession::id).isEqualTo(b.id());
    }

    @Test
    void aReportUpdatesTheSameSessionByItsClaudeId() {
        BoardSession a = f.sessions.report(me, report("b1", "cli-a"));
        BoardSession again = f.sessions.report(me, new SessionsUseCase.Report(null, "b1", null, "cli-a", null, null, null,
                BoardSession.State.IDLE, BoardSession.OpenIn.DESKTOP, null, null, null));

        assertThat(again.id()).isEqualTo(a.id());
        assertThat(again.state()).isEqualTo(BoardSession.State.IDLE);
        assertThat(again.openIn()).isEqualTo(BoardSession.OpenIn.DESKTOP);
        assertThat(again.cwd()).isEqualTo("C:/wt/b1");
        assertThat(again.tokensToday()).isEqualTo(1200);
    }

    @Test
    void anotherUsersHelperCannotReportMySession() {
        f.sessions.report(me, report("b1", "cli-a"));
        assertThatThrownBy(() -> f.sessions.report(other, report("b1", "cli-a"))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aBrowserQueuesForItsOwnPcsOnlyAndTheHelperClaimsAndReports() {
        Caller browser = f.browser(me);
        AtomicInteger woken = new AtomicInteger();
        f.sessions.onQueued(woken::incrementAndGet);

        SessionsUseCase.CommandOutcome theirs = f.sessions.queue(browser, other.keyId(), HelperCommand.Kind.START, "b1", "odeysys", null, "{}");
        assertThat(theirs.error()).isEqualTo("NOT_FOUND");

        SessionsUseCase.CommandOutcome mine = f.sessions.queue(browser, null, HelperCommand.Kind.START, "b1", "odeysys", null, "{}");
        assertThat(mine.command().helperKeyId()).isEqualTo(me.keyId());
        assertThat(woken.get()).isEqualTo(1);

        assertThat(f.sessions.claim(other, 5)).isEmpty();
        assertThat(f.sessions.claim(me, 5)).singleElement().extracting(HelperCommand::state).isEqualTo(HelperCommand.State.TAKEN);
        assertThat(f.sessions.claim(me, 5)).isEmpty();

        assertThat(f.sessions.report(other, mine.command().id(), HelperCommand.State.DONE, "x")).isEmpty();
        assertThat(f.sessions.report(me, mine.command().id(), HelperCommand.State.DONE, "started cli-a")).get()
                .extracting(HelperCommand::state).isEqualTo(HelperCommand.State.DONE);
    }

    @Test
    void onlyAWaitingCommandOfTheCallersOwnCanBeCancelled() {
        Caller browser = f.browser(me);
        HelperCommand c = f.sessions.queue(browser, null, HelperCommand.Kind.STOP_ALL, null, "", null, null).command();

        assertThat(f.sessions.cancel(other, c.id())).isEmpty();
        assertThat(f.sessions.cancel(browser, c.id())).get().extracting(HelperCommand::state).isEqualTo(HelperCommand.State.CANCELLED);
        assertThat(f.sessions.claim(me, 5)).isEmpty();
    }

    @Test
    void settingsAreOneJsonObjectPerUserAndNeverHoldASecret() {
        assertThat(f.settings.get(me)).isEqualTo("{}");
        assertThat(f.settings.put(me, "{\"projects\":[{\"project\":\"odeysys\",\"folder\":\"C:/w\"}],\"budget\":{\"dailyTokens\":1500000}}"))
                .isPresent();
        assertThat(f.settings.get(other)).isEqualTo("{}");
        assertThat(f.settings.put(me, "{\"azure\":{\"token\":\"abc\"}}")).isEmpty();
        assertThat(f.settings.put(me, "{\"pat\":\"abc\"}")).isEmpty();
        assertThat(f.settings.put(me, "[1,2]")).isEmpty();
        assertThat(f.settings.put(me, "not json")).isEmpty();
        assertThat(f.settings.get(me)).contains("dailyTokens");
    }
}
