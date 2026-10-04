package com.fathy.alfred.backend.dbcapture.application.port.out;

/** The per-project capture switch - the flag file the reverse proxy reads. A project with no line is off. */
public interface DbCaptureTogglePort {
    boolean isEnabled(String project);

    void setEnabled(String project, boolean enabled);
}
