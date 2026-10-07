package com.fathy.alfred.backend.dbcapture.application.port.out;

/**
 * The per-project ⬢ Redis switch - the flag file the reverse proxy reads (specs/011-redis-capture). A project with no
 * line is off. While on, the reverse proxy adds redis=1 to X-Alfred-Call and the agent records the call's Redis commands.
 */
public interface RedisCaptureTogglePort {
    boolean isOn(String project);

    void setOn(String project, boolean on);
}
