package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import com.fathy.alfred.backend.dbcapture.application.port.out.LogLinkTogglePort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The per-project ▤ Logs switch: proxy/log-link-enabled.flag, bind-mounted into reverse-proxy (which adds
 * {@code log=1} to X-Alfred-Call while a project is on, so the db-agent tags that request's log lines) and here.
 * Same format and behaviour as the ◆ switch's file (specs/008-logs-call-link).
 */
@Component
public class FileLogLinkToggleAdapter implements LogLinkTogglePort {

    @Value("${LOG_LINK_TOGGLE_FILE:/appdata/log-link-enabled.flag}")
    private String toggleFile;

    @Override
    public boolean isOn(String project) {
        return ProjectFlagFile.isOn(toggleFile, project);
    }

    @Override
    public void setOn(String project, boolean on) {
        ProjectFlagFile.set(toggleFile, project, on);
    }
}
