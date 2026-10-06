package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageProjectLogsUseCase.ProjectLogsView;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import org.springframework.stereotype.Service;

/**
 * Logs linked to calls (specs/008-logs-call-link): the one place that joins a project's inbound calls (their window),
 * database capture (their request thread, the ▤ switch) and the Logs tab (the project's log sources and their lines).
 * It lives in the composition root because it needs all three; each slice stays independent and is reached only
 * through its use-case ports. Logs are read only while the project's ▤ switch and inbound logging are on (FR-006).
 */
@Service
public class CallLogsService {

    private final ManageProjectLogsUseCase projectLogs;
    private final ManageDbCaptureUseCase capture;

    public CallLogsService(ManageProjectLogsUseCase projectLogs, ManageDbCaptureUseCase capture) {
        this.projectLogs = projectLogs;
        this.capture = capture;
    }

    public ProjectLogsView settings(String project) {
        return projectLogs.view(project);
    }

    public ProjectLogsView saveSettings(ProjectLogSettings settings) {
        return projectLogs.save(settings);
    }

    /** True while the project's ▤ switch and its inbound logging are both on - only then are its logs read. */
    boolean linked(String project) {
        return capture.logsLinked(project);
    }
}
