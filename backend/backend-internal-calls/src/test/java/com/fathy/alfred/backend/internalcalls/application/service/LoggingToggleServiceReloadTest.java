package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.out.LoggingTogglePort;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/** The project list behind the Settings tab's "Inbound logging" panel (specs/012-server-program). */
class LoggingToggleServiceReloadTest {

    private final LoggingTogglePort toggles = mock(LoggingTogglePort.class);

    @Test
    void projectsWithAnOutboundAddressAreListedToo() {
        LoggingToggleService service = new LoggingToggleService(toggles, "a:9001:8080:127.0.0.3,b:9002:8081:127.0.0.4:8443,c:9003:8082");
        assertThat(service.getServices()).extracting(s -> s.name()).containsExactly("a", "b", "c", LoggingToggleService.UNKNOWN_NAME);
    }

    @Test
    void reloadReplacesTheListAndTheFlagWithoutARestart() {
        LoggingToggleService service = new LoggingToggleService(toggles, "a:9001:8080");
        service.reload("x:9101:8180,y:9102:8181", true);
        assertThat(service.getServices()).extracting(s -> s.name()).containsExactly("x", "y", LoggingToggleService.UNKNOWN_NAME);
        assertThat(service.isFeatureEnabled()).isTrue();
    }
}
