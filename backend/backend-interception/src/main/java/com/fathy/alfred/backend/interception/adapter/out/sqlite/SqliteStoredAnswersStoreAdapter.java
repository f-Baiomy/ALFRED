package com.fathy.alfred.backend.interception.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Stored answers in interception.db, beside the rules that use them. The body lives in its own
 * table and is read only by {@link #findBody}: {@link #listMeta} and {@link #findMeta} never touch
 * it, so neither the sweep nor the editor ever loads a 10 MB body to read a status code.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.interception", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteStoredAnswersStoreAdapter implements StoredAnswersStorePort {

    private static final String META_COLUMNS = "id, kind, status, headers_json, content_type, size_bytes, secrets_kept, "
            + "secret_names_json, source_direction, source_call_id, source_cycle_id, recorded_at, created_at";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper = new ObjectMapper();

    public SqliteStoredAnswersStoreAdapter(SqliteInterceptionRulesRepository repository) {
        this.jdbc = repository.jdbc();
    }

    @Override
    public synchronized void save(StoredAnswer answer, byte[] body) {
        jdbc.update("INSERT INTO stored_answers (" + META_COLUMNS + ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                answer.id(), answer.kind().name(), answer.status(), write(answer.headers()), answer.contentType(),
                answer.sizeBytes(), answer.secretsKept() == null ? null : (answer.secretsKept() ? 1 : 0),
                write(answer.secretNames()), answer.sourceDirection(), answer.sourceCallId(), answer.sourceCycleId(),
                answer.recordedAt(), answer.createdAt());
        try {
            jdbc.update("INSERT INTO stored_answer_bodies (answer_id, body) VALUES (?,?)", answer.id(), body);
        } catch (RuntimeException e) {
            // Never a description without its body - a rule could be saved against it and serve nothing.
            jdbc.update("DELETE FROM stored_answers WHERE id = ?", answer.id());
            throw e;
        }
    }

    @Override
    public Optional<StoredAnswer> findMeta(String id) {
        return jdbc.query("SELECT " + META_COLUMNS + " FROM stored_answers WHERE id = ?", metaRow(), id)
                .stream().findFirst();
    }

    @Override
    public Optional<byte[]> findBody(String id) {
        return jdbc.query("SELECT body FROM stored_answer_bodies WHERE answer_id = ?",
                (rs, rowNum) -> rs.getBytes("body"), id).stream().findFirst();
    }

    @Override
    public List<StoredAnswer> listMeta() {
        return jdbc.query("SELECT " + META_COLUMNS + " FROM stored_answers ORDER BY created_at", metaRow());
    }

    @Override
    public synchronized void delete(String id) {
        // Both, explicitly: the pool does not turn SQLite's foreign_keys pragma on, so the
        // ON DELETE CASCADE in the schema documents intent rather than enforcing it.
        jdbc.update("DELETE FROM stored_answer_bodies WHERE answer_id = ?", id);
        jdbc.update("DELETE FROM stored_answers WHERE id = ?", id);
    }

    private RowMapper<StoredAnswer> metaRow() {
        return (rs, rowNum) -> {
            int kept = rs.getInt("secrets_kept");
            Boolean secretsKept = rs.wasNull() ? null : kept == 1;
            int status = rs.getInt("status");
            Integer statusValue = rs.wasNull() ? null : status;
            return new StoredAnswer(
                    rs.getString("id"),
                    StoredAnswer.Kind.valueOf(rs.getString("kind")),
                    statusValue,
                    read(rs.getString("headers_json"), new TypeReference<Map<String, String>>() { }),
                    rs.getString("content_type"),
                    rs.getLong("size_bytes"),
                    secretsKept,
                    read(rs.getString("secret_names_json"), new TypeReference<List<String>>() { }),
                    rs.getString("source_direction"),
                    rs.getString("source_call_id"),
                    rs.getString("source_cycle_id"),
                    rs.getString("recorded_at"),
                    rs.getString("created_at"));
        };
    }

    private String write(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Could not serialise a stored answer", e);
        }
    }

    private <T> T read(String json, TypeReference<T> type) {
        if (json == null) {
            return null;
        }
        try {
            return mapper.readValue(json, type);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Unreadable stored answer metadata", e);
        }
    }
}
