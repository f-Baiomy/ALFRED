package com.fathy.alfred.backend.server.config;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RunningSettingsTest {

    @Test
    void theUiPortIsWhatTheBackendListensOnNotWhatEnvSaysWhileAChangeWaitsForARestart() {
        Map<String, String> running = ServerSliceConfiguration.runningSettings(
                Map.of("ALFRED_UI_PORT", "3000", "ALFRED_MEMORY", "2g"),
                Map.of("ALFRED_UI_PORT", "3017", "ALFRED_MEMORY", "3g"),
                3000);
        // .env says 3017 (pending), the backend runs on 3000: setting it back to 3000 is Alfred's own port.
        assertThat(running.get("ALFRED_UI_PORT")).isEqualTo("3000");
        assertThat(running.get("ALFRED_MEMORY")).isEqualTo("3g");
    }
}
