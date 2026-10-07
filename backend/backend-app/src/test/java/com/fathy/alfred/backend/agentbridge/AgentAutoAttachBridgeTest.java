package com.fathy.alfred.backend.agentbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.AttachMode;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.ExecutorService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AgentAutoAttachBridgeTest {

    private final ManageDbCaptureUseCase capture = mock(ManageDbCaptureUseCase.class);
    private final ServerRuntimeUseCase runtime = mock(ServerRuntimeUseCase.class);
    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-07T20:00:00Z"));
    /** Runs the ask on the calling thread so the test sees it; the real bridge uses its own thread. */
    private final ExecutorService inline = inlineExecutor();
    private final AgentAutoAttachBridge bridge = new AgentAutoAttachBridge(capture, runtime, clock, inline);

    private static CallRecord call(String project) {
        return new CallRecord("c1", "http://localhost:8080/x", "http://127.0.0.1:9001/x", "GET", null, "2026-10-07T20:00:00Z", null, null,
                null, null, null, null, project, null, null, null);
    }

    @Test
    void aCallForAProjectWithoutAReportingAgentAsksTheSupervisorOnceEveryThirtySeconds() {
        when(capture.projects()).thenReturn(List.of(new ProjectCaptureStatus("odeysys", true, true, false, null)));
        when(capture.settings("odeysys")).thenReturn(DbCaptureSettings.defaults());
        when(runtime.attachAgent(anyString(), any(), anyBoolean())).thenReturn(true);

        bridge.onCallPrepared(call("odeysys"));
        bridge.onCallPrepared(call("odeysys"));
        verify(runtime).attachAgent("odeysys", List.of("proxy", "db", "logs", "redis"), false);

        clock.now = clock.now.plusSeconds(31);
        bridge.onCallPrepared(call("odeysys"));
        verify(runtime, org.mockito.Mockito.times(2)).attachAgent("odeysys", List.of("proxy", "db", "logs", "redis"), false);
    }

    @Test
    void anAttachedAgentOrTheSwitchOffAsksNothing() {
        when(capture.projects()).thenReturn(List.of(new ProjectCaptureStatus("odeysys", true, true, true, null)));
        bridge.onCallPrepared(call("odeysys"));
        verify(runtime, never()).attachAgent(anyString(), any(), anyBoolean());

        when(capture.projects()).thenReturn(List.of(new ProjectCaptureStatus("odeysys", true, true, false, null)));
        when(capture.settings("odeysys")).thenReturn(new DbCaptureSettings(1, List.of(), true, null, List.of(), List.of(), List.of(), 5, false,
                "ERROR", null, AttachMode.OFF, true));
        clock.now = clock.now.plusSeconds(60);
        bridge.onCallPrepared(call("odeysys"));
        verify(runtime, never()).attachAgent(anyString(), any(), anyBoolean());
    }

    @Test
    void withoutTheProxyFeatureOnlyCaptureIsLoadedAndStartAsksForEveryProject() {
        when(capture.projects()).thenReturn(List.of(new ProjectCaptureStatus("odeysys", true, true, false, null),
                new ProjectCaptureStatus("core", false, true, true, null)));
        when(capture.settings("odeysys")).thenReturn(new DbCaptureSettings(1, List.of(), true, null, List.of(), List.of(), List.of(), 5, false,
                "ERROR", null, AttachMode.WHEN_ASKED, false));
        when(runtime.attachAgent(anyString(), any(), anyBoolean())).thenReturn(true);
        bridge.started();
        verify(runtime).attachAgent("odeysys", List.of("db", "logs", "redis"), false);
        verify(runtime, never()).attachAgent(org.mockito.ArgumentMatchers.eq("core"), any(), anyBoolean());
    }

    @Test
    void aCallWithoutAProjectIsIgnored() {
        bridge.onCallPrepared(call(null));
        verify(runtime, never()).attachAgent(anyString(), any(), anyBoolean());
        assertThat(bridge.onCallCompleted(call("odeysys"))).isEmpty();
    }

    @Test
    void inAutomaticModeTheAppAppearingOnItsPortAttachesAtOnceAndForced() {
        when(capture.settings("odeysys")).thenReturn(new DbCaptureSettings(1, List.of(), true, null, List.of(), List.of(), List.of(), 5, false,
                "ERROR", null, AttachMode.AUTOMATIC, true));
        when(runtime.attachAgent(anyString(), any(), anyBoolean())).thenReturn(true);
        bridge.appSeen(new ServerRuntimeUseCase.AppSeen("odeysys", 9001, 68108, true));
        verify(runtime).attachAgent("odeysys", List.of("proxy", "db", "logs", "redis"), true);
        // the port closing is not an attach
        bridge.appSeen(new ServerRuntimeUseCase.AppSeen("odeysys", 9001, 0, false));
        verify(runtime, org.mockito.Mockito.times(1)).attachAgent(anyString(), any(), anyBoolean());
    }

    @Test
    void whenAskedAndOffIgnoreTheAppAppearing() {
        when(capture.settings("odeysys")).thenReturn(DbCaptureSettings.defaults());   // WHEN_ASKED
        bridge.appSeen(new ServerRuntimeUseCase.AppSeen("odeysys", 9001, 68108, true));
        when(capture.settings("core")).thenReturn(new DbCaptureSettings(1, List.of(), true, null, List.of(), List.of(), List.of(), 5, false,
                "ERROR", null, AttachMode.OFF, true));
        bridge.appSeen(new ServerRuntimeUseCase.AppSeen("core", 9002, 777, true));
        verify(runtime, never()).attachAgent(anyString(), any(), anyBoolean());
    }

    @Test
    void theDefaultModeIsWhenAsked() {
        assertThat(DbCaptureSettings.defaults().attachMode()).isEqualTo(AttachMode.WHEN_ASKED);
        assertThat(DbCaptureSettings.defaults().attachesWhenAsked()).isTrue();
        assertThat(DbCaptureSettings.defaults().attachesAutomatically()).isFalse();
        assertThat(AttachMode.of("automatic")).isEqualTo(AttachMode.AUTOMATIC);
        assertThat(AttachMode.of("false")).isEqualTo(AttachMode.OFF);
        assertThat(AttachMode.of("true")).isEqualTo(AttachMode.WHEN_ASKED);
    }

    private static ExecutorService inlineExecutor() {
        return new java.util.concurrent.AbstractExecutorService() {
            private boolean down;
            public void shutdown() { down = true; }
            public List<Runnable> shutdownNow() { down = true; return List.of(); }
            public boolean isShutdown() { return down; }
            public boolean isTerminated() { return down; }
            public boolean awaitTermination(long t, java.util.concurrent.TimeUnit u) { return true; }
            public void execute(Runnable r) { r.run(); }
        };
    }

    private static final class MutableClock extends Clock {
        Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        public ZoneOffset getZone() { return ZoneOffset.UTC; }
        public Clock withZone(java.time.ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
}
