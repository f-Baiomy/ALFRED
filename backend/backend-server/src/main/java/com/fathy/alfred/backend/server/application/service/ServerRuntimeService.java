package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.ServerRuntimeUseCase;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.application.port.out.HistoryPort;
import com.fathy.alfred.backend.server.application.port.out.PendingRestartPort;
import com.fathy.alfred.backend.server.application.port.out.RuntimeInfoPort;
import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.ServerStatus;

import java.util.ArrayList;
import java.util.List;

/**
 * Status and restarts (US4). Restarts go through the supervisor, which owns the processes, so "Restart Alfred" keeps
 * the proxies serving the user's apps. A restart waits for a save in progress (they share one lock), so a setting
 * saved a moment before is written before the backend goes down.
 */
public class ServerRuntimeService implements ServerRuntimeUseCase {

    private final SupervisorPort supervisor;
    private final RuntimeInfoPort runtime;
    private final PendingRestartPort pending;
    private final HistoryPort history;
    private final EnvFilePort envFile;
    private final ServerEventsPort events;
    private final RuntimeMode mode;
    private final Object saveLock;

    public ServerRuntimeService(SupervisorPort supervisor, RuntimeInfoPort runtime, PendingRestartPort pending,
                                HistoryPort history, EnvFilePort envFile, ServerEventsPort events, RuntimeMode mode,
                                Object saveLock) {
        this.supervisor = supervisor;
        this.runtime = runtime;
        this.pending = pending;
        this.history = history;
        this.envFile = envFile;
        this.events = events;
        this.mode = mode;
        this.saveLock = saveLock;
    }

    @Override
    public ServerStatus status() {
        List<ServerStatus.ProcessStatus> processes = new ArrayList<>(supervisor.processes().orElse(List.of()));
        if (processes.stream().noneMatch(p -> p.name().equals("BACKEND"))) {
            processes.add(0, new ServerStatus.ProcessStatus("BACKEND", ServerStatus.ProcessState.RUNNING, runtime.pid(),
                    runtime.startedAt(), 0, List.of(), "", -1));
        }
        return new ServerStatus(runtime.version(), runtime.installDir(), mode, runtime.startedAt(), runtime.pid(),
                runtime.heapUsedBytes(), runtime.heapMaxBytes(), processes);
    }

    @Override
    public void restart(Target target) {
        if (mode != RuntimeMode.NATIVE || !supervisor.available()) {
            throw new IllegalStateException(mode == RuntimeMode.DOCKER
                    ? "Alfred runs with Docker here: restart it with python3 restart.py"
                    : "No supervisor is running - start Alfred with 'alfred start' to restart it from here");
        }
        synchronized (saveLock) {
            events.serverChanged("restart");
            if (target == Target.BACKEND) {
                supervisor.restartBackend();
            } else {
                supervisor.restartProxies();
            }
        }
    }

    @Override
    public void started() {
        if (mode != RuntimeMode.NATIVE) {
            return;
        }
        // .env is read at start, so every change that was waiting for a restart is in effect now.
        pending.replace(List.of());
        if (envFile.exists() && history.lastKnownContent().isEmpty()) {
            String content = envFile.read().render();
            history.append(HistoryEntry.HistorySource.INSTALL, "first start of the backend", List.of(), content, content);
        }
    }

    @Override
    public void processChanged(String process) {
        events.serverChanged("process");
    }
}
