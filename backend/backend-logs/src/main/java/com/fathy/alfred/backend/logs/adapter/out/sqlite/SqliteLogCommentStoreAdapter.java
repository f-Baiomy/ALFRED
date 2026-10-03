package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.LogCommentStorePort;
import com.fathy.alfred.backend.logs.domain.model.LogComment;
import com.fathy.alfred.backend.logs.domain.model.SavedView;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

/** Comments (line- or field-anchored) and saved views in logs.db. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogCommentStoreAdapter implements LogCommentStorePort {

    private static final RowMapper<LogComment> COMMENT = (rs, i) -> new LogComment(rs.getString("id"), rs.getString("source_id"),
            rs.getString("line_id"), rs.getString("path"), rs.getString("text"), rs.getString("author_profile_id"),
            rs.getString("created_at"));
    private static final String INSERT = "INSERT INTO log_comment (id, source_id, line_id, path, text, author_profile_id, created_at) "
            + "VALUES (?,?,?,?,?,?,?)";

    private final SqliteLogsRepository repository;
    private final ObjectMapper objectMapper;

    public SqliteLogCommentStoreAdapter(SqliteLogsRepository repository, ObjectMapper objectMapper) {
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<LogComment> forLine(String sourceId, String lineId) {
        return repository.jdbc().query("SELECT * FROM log_comment WHERE source_id = ? AND line_id = ? ORDER BY created_at", COMMENT,
                sourceId, lineId);
    }

    @Override
    public Map<String, Integer> counts(String sourceId, List<String> lineIds) {
        Map<String, Integer> out = new HashMap<>();
        if (lineIds.isEmpty()) {
            return out;
        }
        Object[] params = new Object[lineIds.size() + 1];
        params[0] = sourceId;
        for (int i = 0; i < lineIds.size(); i++) {
            params[i + 1] = lineIds.get(i);
        }
        repository.jdbc().query("SELECT line_id, count(*) n FROM log_comment WHERE source_id = ? AND line_id IN ("
                        + lineIds.stream().map(x -> "?").collect(Collectors.joining(",")) + ") GROUP BY line_id",
                rs -> {
                    out.put(rs.getString(1), rs.getInt(2));
                }, params);
        return out;
    }

    @Override
    public long countForSource(String sourceId) {
        Long n = repository.jdbc().queryForObject("SELECT count(*) FROM log_comment WHERE source_id = ?", Long.class, sourceId);
        return n == null ? 0 : n;
    }

    @Override
    public void save(LogComment c) {
        repository.jdbc().update(INSERT, c.id(), c.sourceId(), c.lineId(), c.path(), c.text(), c.authorProfileId(), c.createdAt());
    }

    @Override
    public void saveAll(List<LogComment> comments) {
        repository.jdbc().batchUpdate(INSERT, comments.stream().map(c -> new Object[]{c.id(), c.sourceId(), c.lineId(), c.path(),
                c.text(), c.authorProfileId(), c.createdAt()}).toList());
    }

    @Override
    public Optional<LogComment> get(String commentId) {
        return repository.jdbc().query("SELECT * FROM log_comment WHERE id = ?", COMMENT, commentId).stream().findFirst();
    }

    @Override
    public void delete(String commentId) {
        repository.jdbc().update("DELETE FROM log_comment WHERE id = ?", commentId);
    }

    @Override
    public List<SavedView> views(String sourceId) {
        return repository.jdbc().query("SELECT * FROM log_saved_view WHERE source_id = ? ORDER BY created_at", (rs, i) -> {
            try {
                return new SavedView(rs.getString("id"), rs.getString("source_id"), rs.getString("name"),
                        objectMapper.readTree(rs.getString("state_json")), rs.getString("created_at"));
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Stored view is unreadable", e);
            }
        }, sourceId);
    }

    @Override
    public void saveView(SavedView v) {
        repository.jdbc().update("INSERT INTO log_saved_view (id, source_id, name, state_json, created_at) VALUES (?,?,?,?,?)",
                v.id(), v.sourceId(), v.name(), v.state().toString(), v.createdAt());
    }

    @Override
    public void deleteView(String sourceId, String viewId) {
        repository.jdbc().update("DELETE FROM log_saved_view WHERE source_id = ? AND id = ?", sourceId, viewId);
    }

    @Override
    public void deleteSource(String sourceId) {
        repository.jdbc().update("DELETE FROM log_comment WHERE source_id = ?", sourceId);
        repository.jdbc().update("DELETE FROM log_saved_view WHERE source_id = ?", sourceId);
    }
}
