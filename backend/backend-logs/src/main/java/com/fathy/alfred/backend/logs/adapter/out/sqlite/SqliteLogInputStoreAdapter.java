package com.fathy.alfred.backend.logs.adapter.out.sqlite;

import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;

/** Inputs and chunked-upload bookkeeping in logs.db. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.logs", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteLogInputStoreAdapter implements LogInputStorePort {

    private static final RowMapper<LogInput> INPUT = (rs, i) -> new LogInput(rs.getString("id"), rs.getString("source_id"),
            InputKind.valueOf(rs.getString("kind")), rs.getString("path"), rs.getString("file_name"), rs.getString("fingerprint"),
            InputStatus.valueOf(rs.getString("status")), rs.getString("status_reason"), rs.getLong("position"),
            rs.getLong("lines_read"), rs.getLong("total_bytes"), rs.getLong("mismatch_count"), rs.getLong("unparsed_count"),
            rs.getString("started_at"), rs.getString("updated_at"), rs.getString("parent_id"), rs.getString("options"));

    private final SqliteLogsRepository repository;

    public SqliteLogInputStoreAdapter(SqliteLogsRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<LogInput> bySource(String sourceId) {
        return repository.jdbc().query("SELECT * FROM log_input WHERE source_id = ? ORDER BY started_at", INPUT, sourceId);
    }

    @Override
    public List<LogInput> all() {
        return repository.jdbc().query("SELECT * FROM log_input", INPUT);
    }

    @Override
    public Optional<LogInput> get(String inputId) {
        return repository.jdbc().query("SELECT * FROM log_input WHERE id = ?", INPUT, inputId).stream().findFirst();
    }

    /** Position and counters are owned by the ingest transaction; saving status never moves them. */
    @Override
    public void save(LogInput in) {
        repository.jdbc().update("""
                INSERT INTO log_input (id, source_id, kind, path, file_name, fingerprint, status, status_reason, position, lines_read,
                  total_bytes, mismatch_count, unparsed_count, started_at, updated_at, parent_id, options)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET status = excluded.status, status_reason = excluded.status_reason,
                  total_bytes = excluded.total_bytes, path = excluded.path, fingerprint = excluded.fingerprint,
                  updated_at = excluded.updated_at, options = excluded.options
                """, in.id(), in.sourceId(), in.kind().name(), in.path(), in.fileName(), in.fingerprint(), in.status().name(),
                in.statusReason(), in.position(), in.linesRead(), in.totalBytes(), in.mismatchCount(), in.unparsedCount(),
                in.startedAt(), Instant.now().toString(), in.parentId(), in.options());
    }

    @Override
    public List<LogInput> byParent(String parentId) {
        return repository.jdbc().query("SELECT * FROM log_input WHERE parent_id = ? ORDER BY file_name", INPUT, parentId);
    }

    @Override
    public void setPosition(String inputId, long position) {
        repository.jdbc().update("UPDATE log_input SET position = ? WHERE id = ?", position, inputId);
    }

    @Override
    public void clearMismatchCounts(String sourceId) {
        repository.jdbc().update("UPDATE log_input SET mismatch_count = 0 WHERE source_id = ?", sourceId);
    }

    @Override
    public void resetPosition(String inputId) {
        repository.jdbc().update("UPDATE log_input SET position = 0 WHERE id = ?", inputId);
    }

    @Override
    public void delete(String inputId) {
        repository.jdbc().update("DELETE FROM log_input WHERE id = ?", inputId);
    }

    @Override
    public void saveUpload(Upload u) {
        repository.jdbc().update("""
                INSERT INTO log_upload (id, file_name, size, chunk_size, received, input_id) VALUES (?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET received = excluded.received, input_id = excluded.input_id
                """, u.id(), u.fileName(), u.size(), u.chunkSize(),
                u.received().stream().sorted().map(String::valueOf).collect(Collectors.joining(",")), u.inputId());
    }

    @Override
    public Optional<Upload> upload(String uploadId) {
        return repository.jdbc().query("SELECT * FROM log_upload WHERE id = ?", (rs, i) -> {
            String r = rs.getString("received");
            Set<Integer> received = r.isEmpty() ? new TreeSet<>()
                    : Arrays.stream(r.split(",")).map(Integer::parseInt).collect(Collectors.toCollection(TreeSet::new));
            return new Upload(rs.getString("id"), rs.getString("file_name"), rs.getLong("size"), rs.getInt("chunk_size"), received,
                    rs.getString("input_id"));
        }, uploadId).stream().findFirst();
    }

    @Override
    public void deleteUpload(String uploadId) {
        repository.jdbc().update("DELETE FROM log_upload WHERE id = ?", uploadId);
    }
}
