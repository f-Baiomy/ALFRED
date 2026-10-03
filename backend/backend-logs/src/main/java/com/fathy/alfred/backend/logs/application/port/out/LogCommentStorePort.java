package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.LogComment;
import com.fathy.alfred.backend.logs.domain.model.SavedView;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Comments and saved views - both small, both owned by a source. */
public interface LogCommentStorePort {

    List<LogComment> forLine(String sourceId, String lineId);

    Map<String, Integer> counts(String sourceId, List<String> lineIds);

    long countForSource(String sourceId);

    void save(LogComment comment);

    void saveAll(List<LogComment> comments);

    Optional<LogComment> get(String commentId);

    void delete(String commentId);

    List<SavedView> views(String sourceId);

    void saveView(SavedView view);

    void deleteView(String sourceId, String viewId);

    void deleteSource(String sourceId);
}
