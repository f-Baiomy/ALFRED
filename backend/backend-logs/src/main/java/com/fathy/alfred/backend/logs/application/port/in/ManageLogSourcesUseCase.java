package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;

import java.util.List;

/** Log sources and their structure (FR-001, FR-010..016, FR-043/044/047/048). */
public interface ManageLogSourcesUseCase {

    record SourceView(LogSource source, List<com.fathy.alfred.backend.logs.domain.model.LogInput> inputs, String structureId) {
    }

    /** @param structures how many different line structures the sample has (all of them load into one source) */
    record Preview(LogStructure structure, int sampledLines, int structures, String matchingSourceId, String matchingSourceName) {
    }

    record DeleteImpact(long lines, long comments, long pinned) {
    }

    List<SourceView> list();

    SourceView get(String id);

    /** Detects a structure from sample lines (uploads: read in the browser) or a server file (the first 1,000 lines). */
    Preview preview(List<String> sampleLines, String serverPath);

    /** The same, from the first lines of one file of a watched folder (logs_watch_dirs). */
    Preview previewWatched(String folder, String relativePath);

    SourceView create(String name, RawMode rawMode, PrivacyMode privacyMode, LogStructure structure);

    /** @param retentionMaxBytes 0 = keep every line; otherwise 100 MB - 500 GB */
    SourceView update(String id, String name, Long retentionMaxBytes);

    DeleteImpact deleteImpact(String id);

    void delete(String id);

    LogStructure structure(String id);

    /** Saves settings; type, search-mode, role and level changes start background rebuilds. */
    LogStructure updateStructure(String id, LogStructure structure);

    /** A line structure's name and summary template (blank = automatic name / the source's template). */
    void updateStructureSettings(String sourceId, int structureId, String name, String template);

    /** Moves one line structure's lines into a new source (COPY mode: their raw lines are re-loaded there). */
    SourceView moveStructure(String sourceId, int structureId, String newName);
}
