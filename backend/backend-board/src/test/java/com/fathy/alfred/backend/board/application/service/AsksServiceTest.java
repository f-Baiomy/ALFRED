package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.adapter.out.sqlite.TestRepositories;
import com.fathy.alfred.backend.board.application.port.in.AsksUseCase.NewAsk;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase;
import com.fathy.alfred.backend.board.application.port.out.AskStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Ask;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** specs/017 R24, R38: a question asked from the board goes to the cycle's chat, and its answer comes back. */
class AsksServiceTest {

    @TempDir
    Path dir;

    private BoardFixture f;
    private AsksService asks;
    private SkillRunsUseCase runs;
    private final List<String> signals = new ArrayList<>();
    private CardDetail card;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        runs = mock(SkillRunsUseCase.class);
        SkillRun run = mock(SkillRun.class);
        when(run.id()).thenReturn("run-1");
        when(runs.request(any())).thenReturn(SkillRunsUseCase.Outcome.ok(run));
        BoardNotificationPort notifications = new BoardNotificationPort() {
            @Override
            public void changed(String project, String cycleId, String cardId, String what) {
                signals.add(what);
            }

            @Override
            public void agentStatus(com.fathy.alfred.backend.board.domain.model.AgentStatus status) {
            }
        };
        asks = new AsksService((AskStorePort) TestRepositories.snippets(f.store), f.store, runs, notifications,
                JsonMapper.builder().build(), f.clock);
        card = f.add(Actor.USER, "odeysys", CardKind.BUG, "Fare drifts", "");
        f.store.find(card.card().id()); // the card exists
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    @Test
    void anAskFromACardInACycleGoesToThatCyclesChatAsAlfredAsk() {
        var sent = asks.ask(Actor.USER, new NewAsk(null, "c-1", card.card().id(), "inline:card:x:desc:0", "snippet", "Why is 3 slow?", "{\"ms\":[1,2]}"));

        assertThat(sent.error()).isNull();
        Ask a = sent.ask();
        assertThat(a.state()).isEqualTo(Ask.State.OPEN);
        assertThat(a.project()).isEqualTo("odeysys");
        assertThat(a.cardNumber()).isEqualTo(card.card().number());
        ArgumentCaptor<SkillRunsUseCase.Request> r = ArgumentCaptor.forClass(SkillRunsUseCase.Request.class);
        verify(runs).request(r.capture());
        assertThat(r.getValue().command()).isEqualTo("/alfred-ask " + a.id());
        assertThat(r.getValue().cycleId()).isEqualTo("c-1");
        assertThat(r.getValue().prompt()).startsWith("/alfred-ask " + a.id()).contains("board_ask_get " + a.id()).contains("Why is 3 slow?");
        assertThat(asks.get(a.id()).orElseThrow().data()).isEqualTo("{\"ms\":[1,2]}");
    }

    @Test
    void onlyClaudeAnswersOnceAndTheAskerHearsIt() {
        Ask a = asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", null, null, "editor", "Shorten this", null)).ask();
        assertThat(asks.answer(Actor.USER, a.id(), "x").error()).isEqualTo("invalid");
        var done = asks.answer(Actor.CLAUDE, a.id(), "Shorter.");
        assertThat(done.ask().state()).isEqualTo(Ask.State.ANSWERED);
        assertThat(asks.get(a.id()).orElseThrow().answer()).isEqualTo("Shorter.");
        assertThat(signals).contains("ask:" + a.id());
        assertThat(asks.answer(Actor.CLAUDE, a.id(), "Again").error()).isEqualTo("conflict");
    }

    @Test
    void anAskNeedsACycleAQuestionAndJsonAndARefusedRunIsSaidPlainly() {
        assertThat(asks.ask(Actor.USER, new NewAsk("odeysys", null, null, null, null, "q", null)).message()).contains("cycle");
        assertThat(asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", null, null, null, " ", null)).error()).isEqualTo("invalid");
        assertThat(asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", null, null, null, "q", "{bad")).message()).contains("JSON");
        assertThat(asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", "nope", null, null, "q", null)).error()).isEqualTo("not-found");
        when(runs.request(any())).thenReturn(SkillRunsUseCase.Outcome.refused("not-found", "No chat handles this cycle"));
        var refused = asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", null, null, null, "q", null));
        assertThat(refused.message()).isEqualTo("No chat handles this cycle");
    }

    @Test
    void theAskerCanStopWaitingAndTheRunIsCancelled() {
        Ask a = asks.ask(Actor.USER, new NewAsk("odeysys", "c-1", null, null, null, "q", null)).ask();
        assertThat(asks.cancel(a.id()).ask().state()).isEqualTo(Ask.State.CANCELLED);
        verify(runs).stop("run-1");
        assertThat(asks.answer(Actor.CLAUDE, a.id(), "late").error()).isEqualTo("conflict");
    }
}
