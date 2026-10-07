package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import com.fathy.alfred.backend.server.application.port.out.RuntimeInfoPort;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ServerRuntimeServiceTest {

    private static final RuntimeInfoPort RUNTIME = new RuntimeInfoPort() {
        public String version() { return "1.0"; }
        public String installDir() { return "/opt/alfred"; }
        public Instant startedAt() { return Instant.EPOCH; }
        public long pid() { return 42; }
        public long heapUsedBytes() { return 1; }
        public long heapMaxBytes() { return 2; }
    };

    private final Fakes.Supervisor supervisor = new Fakes.Supervisor();
    private final Fakes.Pending pending = new Fakes.Pending();
    private final Fakes.History history = new Fakes.History();
    private final Fakes.Env env = new Fakes.Env("ALFRED_MEMORY=3g\n");
    private final Fakes.Events events = new Fakes.Events();

    private ServerRuntimeService service(RuntimeMode mode) {
        return new ServerRuntimeService(supervisor, RUNTIME, pending, history, env, events, mode, new Object());
    }

    @Test
    void restartsGoThroughTheSupervisorAndTellThePages() {
        ServerRuntimeService service = service(RuntimeMode.NATIVE);
        service.restart(ServerRuntimeUseCase.Target.PROXIES);
        service.restart(ServerRuntimeUseCase.Target.BACKEND);
        assertThat(supervisor.proxyRestarts).isEqualTo(1);
        assertThat(supervisor.backendRestarts).isEqualTo(1);
        assertThat(events.sent).containsExactly("restart", "restart");
    }

    @Test
    void dockerModeAndAMissingSupervisorRefuseRestarts() {
        assertThatThrownBy(() -> service(RuntimeMode.DOCKER).restart(ServerRuntimeUseCase.Target.BACKEND))
                .hasMessageContaining("restart.py");
        supervisor.available = false;
        assertThatThrownBy(() -> service(RuntimeMode.NATIVE).restart(ServerRuntimeUseCase.Target.BACKEND))
                .hasMessageContaining("alfred start");
        assertThat(supervisor.backendRestarts).isZero();
    }

    @Test
    void startingClearsPendingRestartsAndRecordsAHistoryBaselineOnce() {
        pending.list = new java.util.ArrayList<>(List.of(new PendingRestart("ALFRED_MEMORY", "2g", "3g", Instant.EPOCH)));
        ServerRuntimeService service = service(RuntimeMode.NATIVE);
        service.started();
        service.started();
        assertThat(pending.list).isEmpty();
        assertThat(history.entries).singleElement().satisfies(e -> assertThat(e.source()).isEqualTo(HistoryEntry.HistorySource.INSTALL));
        assertThat(history.lastKnownContent()).contains("ALFRED_MEMORY=3g\n");
    }

    @Test
    void statusAlwaysListsTheBackend() {
        assertThat(service(RuntimeMode.DOCKER).status().processes()).extracting(p -> p.name()).containsExactly("BACKEND");
    }
}
