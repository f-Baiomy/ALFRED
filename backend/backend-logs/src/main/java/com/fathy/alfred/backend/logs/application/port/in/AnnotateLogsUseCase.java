package com.fathy.alfred.backend.logs.application.port.in;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.logs.domain.model.LogComment;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.SavedView;

import java.util.List;

/** Comments, pins and saved views (FR-033, FR-035, FR-040, FR-042). */
public interface AnnotateLogsUseCase {

    /** A selection is either explicit line ids or "everything matching this query". */
    record Selection(List<String> lineIds, LogQuery allMatching) {
    }

    List<LogComment> comments(String sourceId, String lineId);

    LogComment comment(String sourceId, String lineId, String path, String text, String authorProfileId);

    void deleteComment(String sourceId, String commentId);

    long commentAll(String sourceId, Selection selection, String text, String authorProfileId);

    long pin(String sourceId, Selection selection);

    List<SavedView> views(String sourceId);

    SavedView saveView(String sourceId, String name, JsonNode state);

    void deleteView(String sourceId, String viewId);
}
