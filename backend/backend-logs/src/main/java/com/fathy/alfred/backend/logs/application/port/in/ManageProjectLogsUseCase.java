package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;

import java.util.List;
import java.util.Map;

/** Which log sources belong to a project and how their lines match its calls (specs/008-logs-call-link FR-009/FR-010). */
public interface ManageProjectLogsUseCase {

    /**
     * @param callIdFoundLines per linked source, how many lines carry the call-id field (whether tagging is working)
     */
    record ProjectLogsView(ProjectLogSettings settings, Map<String, Long> callIdFoundLines) {
    }

    /** The project's settings, or the defaults when never saved. */
    ProjectLogSettings settings(String project);

    ProjectLogsView view(String project);

    /** The projects whose calls read this log source (a Logs-tab line's possible calls). */
    List<ProjectLogSettings> readingSource(String sourceId);

    /**
     * Saves after checking every source exists; the thread and call-id fields become exact-searchable (B-tree indexed)
     * in each source's structure, so a call's lines are found by an index, not a scan.
     *
     * @throws LogsException BAD_REQUEST for an unknown source
     */
    ProjectLogsView save(ProjectLogSettings settings);
}
