package com.fathy.alfred.backend.sessions.application.service;

import com.fathy.alfred.backend.sessions.application.port.in.HoldersUseCase;
import com.fathy.alfred.backend.sessions.domain.model.Caller;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class HoldersServiceTest {

    @TempDir
    Path dir;

    private SessionsFixture f;
    private Caller me;
    private Caller myBrowser;
    private Caller ahmed;

    @BeforeEach
    void setUp() {
        f = new SessionsFixture(dir);
        me = f.helper("F.Biomy@tildetech.ae", "WORK-PC");
        myBrowser = f.browser(me);
        ahmed = f.helper("ahmed@tildetech.ae", "DEV-AHMED");
    }

    @Test
    void aBoardNobodyHoldsIsWrittenAsBeforeEvenWithoutAKey() {
        assertThat(f.holders.mayWrite(Optional.empty(), "b1", WriteDecision.Kind.EDIT).allowed()).isTrue();
    }

    @Test
    void aHeldBoardTakesWritesOnlyFromItsHolderOnAnyOfTheirKeys() {
        assertThat(f.holders.take(me, "b1", "odeysys", "s-1").ok()).isTrue();

        assertThat(f.holders.mayWrite(Optional.of(me), "b1", WriteDecision.Kind.EDIT).reason()).isEqualTo(WriteDecision.HOLDER);
        assertThat(f.holders.mayWrite(Optional.of(myBrowser), "b1", WriteDecision.Kind.EDIT).allowed()).isTrue();
        WriteDecision other = f.holders.mayWrite(Optional.of(ahmed), "b1", WriteDecision.Kind.MESSAGE);
        assertThat(other.allowed()).isFalse();
        assertThat(other.holder().user()).isEqualTo("f.biomy@tildetech.ae");
        assertThat(f.holders.mayWrite(Optional.empty(), "b1", WriteDecision.Kind.EDIT).allowed()).isFalse();
    }

    @Test
    void anotherUserCannotTakeAHeldBoardOnlyAskForIt() {
        f.holders.take(me, "b1", "odeysys", "s-1");

        assertThat(f.holders.take(ahmed, "b1", "odeysys", "s-2").error()).isEqualTo("HELD");
        HoldersUseCase.Result asked = f.holders.request(ahmed, "b1", "I'll take the re-test");
        assertThat(asked.ok()).isTrue();
        assertThat(f.holders.holder("b1").orElseThrow().request().user()).isEqualTo("ahmed@tildetech.ae");
    }

    @Test
    void handOverMakesTheRequesterTheHolderAtOnce() {
        f.holders.take(me, "b1", "odeysys", "s-1");
        f.holders.request(ahmed, "b1", "please");

        assertThat(f.holders.answer(ahmed, "b1", HoldersUseCase.Answer.HAND_OVER).error()).isEqualTo("HELD");
        assertThat(f.holders.answer(me, "b1", HoldersUseCase.Answer.HAND_OVER).ok()).isTrue();

        assertThat(f.holders.holder("b1").orElseThrow().user()).isEqualTo("ahmed@tildetech.ae");
        assertThat(f.holders.mayWrite(Optional.of(me), "b1", WriteDecision.Kind.EDIT).allowed()).isFalse();
        assertThat(f.sessions.audit("b1", 10)).extracting(a -> a.what()).contains("Board handed over to ahmed@tildetech.ae");
    }

    @Test
    void keepClearsTheRequestAndReleaseFreesTheBoard() {
        f.holders.take(me, "b1", "odeysys", "s-1");
        f.holders.request(ahmed, "b1", "");
        f.holders.answer(me, "b1", HoldersUseCase.Answer.KEEP);
        assertThat(f.holders.holder("b1").orElseThrow().request()).isNull();

        f.holders.request(ahmed, "b1", "");
        f.holders.answer(me, "b1", HoldersUseCase.Answer.RELEASE);
        assertThat(f.holders.holder("b1")).isEmpty();
        assertThat(f.holders.take(ahmed, "b1", "odeysys", "s-2").ok()).isTrue();
    }

    @Test
    void commentersMayCommentButTheirChatWaitsForTheHolderAndTheyNeverEdit() {
        f.holders.take(me, "b1", "odeysys", "s-1");
        f.holders.commenters(me, "b1", List.of("Ahmed@TildeTech.ae", "not-an-email"));

        assertThat(f.holders.mayWrite(Optional.of(ahmed), "b1", WriteDecision.Kind.COMMENT).reason()).isEqualTo(WriteDecision.COMMENTER);
        assertThat(f.holders.mayWrite(Optional.of(ahmed), "b1", WriteDecision.Kind.MESSAGE).allowed()).isFalse();
        assertThat(f.holders.mayWrite(Optional.of(ahmed), "b1", WriteDecision.Kind.EDIT).allowed()).isFalse();
        assertThat(f.holders.holder("b1").orElseThrow().commenters()).containsExactly("ahmed@tildetech.ae");
    }

    @Test
    void aCommentersChatMessageWaitsUntilTheHolderLetsClaudeAnswerIt() {
        f.holders.take(me, "b1", "odeysys", "s-1");
        Caller stranger = f.helper("x@tildetech.ae", "PC9");
        f.holders.commenters(me, "b1", List.of("ahmed@tildetech.ae"));

        assertThat(f.holders.submit(stranger, "b1", "odeysys", "b1", "hi").error()).isEqualTo("HELD");
        HoldersUseCase.PendingOutcome sent = f.holders.submit(ahmed, "b1", "odeysys", "b1", "check business class too");
        assertThat(sent.message().id()).isPositive();
        assertThat(f.holders.pending(me, "b1")).hasSize(1);
        assertThat(f.holders.pending(stranger, "b1")).isEmpty();

        assertThat(f.holders.resolve(ahmed, sent.message().id(), true).error()).isEqualTo("HELD");
        HoldersUseCase.PendingOutcome ok = f.holders.resolve(me, sent.message().id(), true);
        assertThat(ok.text()).isEqualTo("@ahmed@tildetech.ae asks: check business class too");
        assertThat(f.holders.pending(me, "b1")).isEmpty();
    }

    @Test
    void theAwayRuleHandsOverWhenTheHoldersHelpersHaveBeenQuietLongEnough() {
        f.settings.put(me, "{\"away\":{\"hours\":8,\"action\":\"accept\"}}").orElseThrow();
        f.holders.take(me, "b1", "odeysys", "s-1");

        f.clock.plusMinutes(60);
        f.holders.request(ahmed, "b1", "");
        assertThat(f.holders.holder("b1").orElseThrow().user()).isEqualTo("f.biomy@tildetech.ae");

        f.clock.plusMinutes(9 * 60);
        f.holders.request(ahmed, "b1", "");
        assertThat(f.holders.holder("b1").orElseThrow().user()).isEqualTo("ahmed@tildetech.ae");
    }

    @Test
    void forceReleaseAndARevokedUserFreeTheirBoards() {
        f.holders.take(me, "b1", "odeysys", "s-1");
        f.holders.take(me, "b2", "odeysys", "s-1");

        assertThat(f.holders.forceRelease("b1").ok()).isTrue();
        assertThat(f.keys.adminRevoke(me.keyId())).isTrue();

        assertThat(f.holders.holder("b1")).isEmpty();
        assertThat(f.holders.holder("b2")).isEmpty();
        assertThat(f.sessions.audit("b1", 10)).extracting(a -> a.what()).contains("Force release (admin)");
    }
}
