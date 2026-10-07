package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * The Server card: what runs, since when, how the backend's heap looks, and the agents the supervisor attached to
 * the projects' applications by itself ({@code agents}, docs/server.md "The agent attaches itself").
 */
public record ServerStatus(String version, String installDir, RuntimeMode mode, Instant startedAt, long backendPid,
                           long heapUsedBytes, long heapMaxBytes, List<ProcessStatus> processes, List<AgentAttach> agents) {

    public ServerStatus(String version, String installDir, RuntimeMode mode, Instant startedAt, long backendPid,
                        long heapUsedBytes, long heapMaxBytes, List<ProcessStatus> processes) {
        this(version, installDir, mode, startedAt, backendPid, heapUsedBytes, heapMaxBytes, processes, List.of());
    }

    public enum ProcessState { RUNNING, STOPPED, RESTARTING, CRASHED, UNKNOWN }

    /** What the supervisor's last attach attempt for a project came to. */
    public enum AgentAttachState { ATTACHED, ATTACHING, NO_JVM, NOT_A_JVM, FAILED, NO_PROJECT, UNKNOWN }

    /**
     * The supervisor's account of one project's agent: the JVM it found on the project's upstream {@code port}
     * ({@code pid}, 0 when none), what happened, and the features it loaded ("proxy,db,logs,redis").
     */
    public record AgentAttach(String project, int port, long pid, AgentAttachState state, String detail, Instant at, String features) {
    }

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
        agents = agents == null ? List.of() : List.copyOf(agents);
    }
}
