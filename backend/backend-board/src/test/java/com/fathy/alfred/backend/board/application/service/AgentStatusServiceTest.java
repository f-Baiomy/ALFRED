package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class AgentStatusServiceTest {

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
    void anUpdateIsHeldAndAnnounced() {
        assertThat(f.agent.status("p")).isEmpty();

        f.agent.update("p", "c-1", AgentStatus.State.WATCHING, 14, 3);

        AgentStatus s = f.agent.status("p").orElseThrow();
        assertThat(s.callsChecked()).isEqualTo(14);
        assertThat(s.cardsAdded()).isEqualTo(3);
        assertThat(s.cycleId()).isEqualTo("c-1");
        assertThat(f.signals).containsExactly("agent:WATCHING");
    }

    @Test
    void pauseHoldsEvenWhenTheWatchLoopKeepsReportingAndResumeLifts() {
        f.agent.update("p", null, AgentStatus.State.WATCHING, 1, 0);
        f.agent.setState("p", AgentStatus.State.PAUSED);

        f.agent.update("p", null, AgentStatus.State.WATCHING, 2, 0);
        assertThat(f.agent.paused("p")).isTrue();

        f.agent.setState("p", AgentStatus.State.WATCHING);
        assertThat(f.agent.paused("p")).isFalse();
        assertThat(f.agent.setState("other", AgentStatus.State.STOPPED)).isEmpty();
    }

    @Test
    void aStatusNotUpdatedForTenMinutesReadsAsStopped() {
        f.agent.update("p", null, AgentStatus.State.WATCHING, 1, 0);
        f.clock.advanceSeconds(9 * 60);
        assertThat(f.agent.status("p").orElseThrow().state()).isEqualTo(AgentStatus.State.WATCHING);

        f.clock.advanceSeconds(2 * 60);
        assertThat(f.agent.status("p").orElseThrow().state()).isEqualTo(AgentStatus.State.STOPPED);
    }
}
