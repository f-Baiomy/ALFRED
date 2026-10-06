package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.application.port.out.ProjectLogsStorePort;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.logs.domain.model.ProjectLogSettings;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * Project log settings and kept lines in logs.db (specs/008-logs-call-link). Kept lines live outside every source's
 * line tables, so a source's retention or deletion never reaches them; they are bounded by what session cycles and
 * imports hold (data-model.md).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteProjectLogsStoreAdapter implements ProjectLogsStorePort {

    static final int MAX_KEEP_BATCH = 500;
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() {
    };

    private final SqliteLogsRepository repository;
    private final ObjectMapper mapper;

    public SqliteProjectLogsStoreAdapter(SqliteLogsRepository repository, ObjectMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    @Override
    public List<ProjectLogSettings> allSettings() {
        return repository.jdbc().query("SELECT project, source_ids, thread_field, time_field, call_id_field, clock_skew_ms FROM project_logs",
                (rs, i) -> new ProjectLogSettings(rs.getString(1), readList(rs.getString(2)), rs.getString(3), rs.getString(4), rs.getString(5),
                        rs.getInt(6)));
    }

    @Override
    public Optional<ProjectLogSettings> settings(String project) {
        return repository.jdbc().query("SELECT project, source_ids, thread_field, time_field, call_id_field, clock_skew_ms FROM project_logs WHERE project = ?",
                (rs, i) -> new ProjectLogSettings(rs.getString(1), readList(rs.getString(2)), rs.getString(3), rs.getString(4), rs.getString(5),
                        rs.getInt(6)), project).stream().findFirst();
    }

    @Override
    public void saveSettings(ProjectLogSettings s) {
        repository.jdbc().update("INSERT INTO project_logs (project, source_ids, thread_field, time_field, call_id_field, clock_skew_ms) VALUES (?,?,?,?,?,?) "
                        + "ON CONFLICT(project) DO UPDATE SET source_ids = excluded.source_ids, thread_field = excluded.thread_field, "
                        + "time_field = excluded.time_field, call_id_field = excluded.call_id_field, clock_skew_ms = excluded.clock_skew_ms",
                s.project(), writeList(s.sourceIds()), s.threadField(), s.timeField(), s.callIdField(), s.clockSkewMs());
    }

    @Override
    public void keep(List<KeptLogLine> lines) {
        if (lines == null || lines.isEmpty()) {
            return;
        }
        for (int i = 0; i < lines.size(); i += MAX_KEEP_BATCH) {
            List<Object[]> args = new ArrayList<>();
            for (KeptLogLine l : lines.subList(i, Math.min(lines.size(), i + MAX_KEEP_BATCH))) {
                args.add(new Object[]{l.callId(), l.sourceId(), l.sourceName(), l.lineId(), l.atMs(), l.level(), l.thread(), l.logger(), l.message(),
                        l.matchedBy(), l.raw(), l.origin().name(), System.currentTimeMillis()});
            }
            repository.jdbc().batchUpdate("INSERT OR REPLACE INTO kept_log_lines (call_id, source_id, source_name, line_id, at_ms, level, thread, logger, "
                    + "message, matched_by, raw, origin, kept_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", args);
        }
    }

    @Override
    public List<KeptLogLine> kept(String callId, int limit) {
        return repository.jdbc().query("SELECT call_id, source_id, source_name, line_id, at_ms, level, thread, logger, message, matched_by, raw, origin "
                        + "FROM kept_log_lines WHERE call_id = ? ORDER BY at_ms, line_id LIMIT ?",
                (rs, i) -> new KeptLogLine(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getLong(5), rs.getString(6),
                        rs.getString(7), rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11),
                        KeptLogLine.Origin.valueOf(rs.getString(12))), callId, limit);
    }

    @Override
    public int removeKept(Collection<String> callIds, KeptLogLine.Origin origin) {
        if (callIds == null || callIds.isEmpty()) {
            return 0;
        }
        int removed = 0;
        List<String> ids = List.copyOf(callIds);
        for (int i = 0; i < ids.size(); i += MAX_KEEP_BATCH) {
            List<String> chunk = ids.subList(i, Math.min(ids.size(), i + MAX_KEEP_BATCH));
            String in = chunk.stream().map(x -> "?").collect(Collectors.joining(","));
            List<Object> args = new ArrayList<>(chunk);
            String byOrigin = "";
            if (origin != null) {
                byOrigin = " AND origin = ?";
                args.add(origin.name());
            }
            removed += repository.jdbc().update("DELETE FROM kept_log_lines WHERE call_id IN (" + in + ")" + byOrigin, args.toArray());
        }
        return removed;
    }

    @Override
    public List<String> callsWithKept(KeptLogLine.Origin origin, int limit) {
        return repository.jdbc().queryForList("SELECT DISTINCT call_id FROM kept_log_lines WHERE origin = ? LIMIT ?", String.class, origin.name(), limit);
    }

    private List<String> readList(String json) {
        try {
            return json == null ? List.of() : mapper.readValue(json, STRINGS);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Stored project log settings are unreadable", e);
        }
    }

    private String writeList(List<String> list) {
        try {
            return mapper.writeValueAsString(list);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialize project log settings", e);
        }
    }
}
