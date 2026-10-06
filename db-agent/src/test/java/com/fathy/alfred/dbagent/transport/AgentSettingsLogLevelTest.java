package com.fathy.alfred.dbagent.transport;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The project's Log level as the heartbeat names it - ERROR unless it says otherwise. */
class AgentSettingsLogLevelTest {

    @Test
    void eachNameMapsToItsRankAndAnythingElseIsError() {
        assertThat(AgentSettings.levelSetting("APP")).isZero();
        assertThat(AgentSettings.levelSetting("trace")).isEqualTo(1);
        assertThat(AgentSettings.levelSetting("DEBUG")).isEqualTo(2);
        assertThat(AgentSettings.levelSetting("INFO")).isEqualTo(3);
        assertThat(AgentSettings.levelSetting(" warn ")).isEqualTo(4);
        assertThat(AgentSettings.levelSetting("ERROR")).isEqualTo(5);
        assertThat(AgentSettings.levelSetting(null)).isEqualTo(5);
        assertThat(AgentSettings.levelSetting("LOUD")).isEqualTo(5);
        assertThat(new AgentSettings().logMinRank()).isEqualTo(5);
    }
}
