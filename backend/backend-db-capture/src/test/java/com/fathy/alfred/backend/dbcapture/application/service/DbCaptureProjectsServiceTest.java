package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureNotificationPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import com.fathy.alfred.backend.dbcapture.application.port.out.InboundProjectsPort;
import com.fathy.alfred.backend.dbcapture.domain.model.AgentStatus;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundProject;
import com.fathy.alfred.backend.dbcapture.domain.model.Thresholds;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DbCaptureProjectsServiceTest {

    private final DbCaptureStorePort store = mock(DbCaptureStorePort.class);
    private final DbCaptureTogglePort toggle = mock(DbCaptureTogglePort.class);
    private final DbCaptureNotificationPort notifications = mock(DbCaptureNotificationPort.class);
    private final InboundProjectsPort inbound = () -> List.of(new InboundProject("wallet-app", true), new InboundProject("core-service", false),
            new InboundProject("unknown", true));
    private final Clock clock = Clock.fixed(Instant.parse("2026-10-05T10:00:00Z"), ZoneOffset.UTC);
    private final DbCaptureProjectsService service = new DbCaptureProjectsService(store, toggle, notifications, Optional.of(inbound), Optional.of(clock));

    @Test
    void listsFrontedProjectsWithTheirSwitchAgentAndInboundState_plusAgentOnlyProjects() {
        when(toggle.isEnabled("wallet-app")).thenReturn(true);
        when(store.agents()).thenReturn(List.of(
                new AgentStatus("a1", "wallet-app", "1.0.0", "Java 8", "WildFly", 0, 0, "2026-10-05T09:59:55Z"),
                new AgentStatus("a0", "wallet-app", "1.0.0", "Java 8", "WildFly", 0, 0, "2026-10-05T08:00:00Z"),
                new AgentStatus("b1", "batch-jobs", "1.0.0", "Java 17", null, 0, 0, "2026-10-05T09:00:00Z")));

        var projects = service.projects();

        assertThat(projects).extracting(p -> p.project()).containsExactly("wallet-app", "core-service", "batch-jobs");
        assertThat(projects.get(0).enabled()).isTrue();
        assertThat(projects.get(0).attached()).isTrue();
        assertThat(projects.get(0).agent().agentId()).isEqualTo("a1");
        assertThat(projects.get(1).inboundLogging()).isFalse();
        assertThat(projects.get(1).agent()).isNull();
        assertThat(projects.get(2).attached()).isFalse(); // seen an hour ago
    }

    @Test
    void switchingOnNeedsInboundLogging_switchingOffNever() {
        assertThatThrownBy(() -> service.setEnabled("core-service", true)).isInstanceOf(InboundLoggingOffException.class);
        verify(toggle, never()).setEnabled(anyString(), anyBoolean());

        service.setEnabled("core-service", false);
        service.setEnabled("wallet-app", true);
        verify(toggle).setEnabled("core-service", false);
        verify(toggle).setEnabled("wallet-app", true);
        verify(notifications).captureSettingsChanged("wallet-app");
    }

    @Test
    void settingsAreValidatedAndNormalised() {
        DbCaptureSettings tooMany = new DbCaptureSettings(0, List.of(), true, Thresholds.DEFAULTS, List.of(), List.of());
        assertThatThrownBy(() -> service.saveSettings("wallet-app", tooMany)).isInstanceOf(IllegalArgumentException.class);
        DbCaptureSettings badTable = new DbCaptureSettings(10, List.of("x; DROP"), true, Thresholds.DEFAULTS, List.of(), List.of());
        assertThatThrownBy(() -> service.saveSettings("wallet-app", badTable)).isInstanceOf(IllegalArgumentException.class);

        DbCaptureSettings saved = service.saveSettings("wallet-app",
                new DbCaptureSettings(2000, List.of(" Payment_Holds ", "payment_holds", ""), false, null, List.of(), List.of("SELECT 1", " ")));
        assertThat(saved.beforeImageTables()).containsExactly("payment_holds");
        assertThat(saved.thresholds()).isEqualTo(Thresholds.DEFAULTS);
        assertThat(saved.ignorePatterns()).containsExactly("SELECT 1");
        verify(store).saveSettings("wallet-app", saved);
        verify(notifications).captureSettingsChanged("wallet-app");
    }

    @Test
    void markingExpectedAddsTheFingerprintOnce() {
        when(store.settings("wallet-app")).thenReturn(DbCaptureSettings.defaults());
        service.markExpected("wallet-app", "a1b2c3d4e5f60718");
        verify(store).saveSettings(any(), any());
        assertThatThrownBy(() -> service.markExpected("wallet-app", "not hex!")).isInstanceOf(IllegalArgumentException.class);
    }
}
