package com.fathy.alfred.backend.dbcapture.application.port.out;

/**
 * The per-project ▤ Logs switch - the flag file the reverse proxy reads. A project with no line is off. While on, the
 * agent tags recorded requests' log lines and ALFRED links the project's calls to its logs; while off it reads none.
 */
public interface LogLinkTogglePort {
    boolean isOn(String project);

    void setOn(String project, boolean on);
}
