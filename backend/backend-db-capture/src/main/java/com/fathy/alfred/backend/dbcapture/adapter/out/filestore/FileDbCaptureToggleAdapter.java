package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The per-project capture switch: proxy/db-capture-enabled.flag, bind-mounted into reverse-proxy (which reads it to
 * decide the {@code db=} part of X-Alfred-Call) and here. Same "name=on|off" line format and same
 * re-read-on-every-call behaviour as backend-internal-calls' FileLoggingToggleAdapter - a human-driven, low-frequency
 * setting, and the proxy edits nothing here so there is nothing to cache against. The one difference: a project
 * with no line is OFF.
 */
@Component
public class FileDbCaptureToggleAdapter implements DbCaptureTogglePort {

    @Value("${DB_CAPTURE_TOGGLE_FILE:/appdata/db-capture-enabled.flag}")
    private String toggleFile;

    @Override
    public boolean isEnabled(String project) {
        return ProjectFlagFile.isOn(toggleFile, project);
    }

    @Override
    public void setEnabled(String project, boolean enabled) {
        ProjectFlagFile.set(toggleFile, project, enabled);
    }
}
