package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;
import java.util.List;

/** The Server card: what runs, since when, and how the backend's heap looks. */
public record ServerStatus(String version, String installDir, RuntimeMode mode, Instant startedAt, long backendPid,
                           long heapUsedBytes, long heapMaxBytes, List<ProcessStatus> processes) {

    public enum ProcessState { RUNNING, STOPPED, RESTARTING, CRASHED, UNKNOWN }

    /**
     * One supervised child. {@code name} is BACKEND, OUTBOUND, REVERSE, MCP or LOG_AGENT.
     *
     * @param listeners the addresses it serves, e.g. "127.0.0.2:443" or "9001 -> 8080"
     * @param callsLastHour calls logged through it in the last hour, or -1 when not applicable
     */
    public record ProcessStatus(String name, ProcessState state, long pid, Instant startedAt, int restarts,
                                List<String> listeners, String detail, long callsLastHour) {

        public ProcessStatus {
            listeners = listeners == null ? List.of() : List.copyOf(listeners);
        }
    }

    public ServerStatus {
        processes = processes == null ? List.of() : List.copyOf(processes);
    }
}
