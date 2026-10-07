package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import com.fathy.alfred.backend.dbcapture.application.port.out.RedisCaptureTogglePort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The per-project ⬢ Redis switch: proxy/redis-capture-enabled.flag, bind-mounted into reverse-proxy (which adds
 * {@code redis=1} to X-Alfred-Call while a project is on) and here. Same format and behaviour as the ◆ and ▤ files.
 */
@Component
public class FileRedisCaptureToggleAdapter implements RedisCaptureTogglePort {

    @Value("${REDIS_CAPTURE_TOGGLE_FILE:/appdata/redis-capture-enabled.flag}")
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
