package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.QuestionFormStorePort;
import com.fathy.alfred.backend.board.domain.model.QuestionForm;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * The questions forms Alfred made (specs/037) in board.db, through the board repository's connection pool. A form is
 * written once and read when an answers file comes back; its questions are kept as JSON (they are only ever read whole).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteQuestionFormRepository implements QuestionFormStorePort {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<List<QuestionForm.Item>> ITEMS = new TypeReference<>() {
    };

    private final JdbcTemplate jdbc;

    public SqliteQuestionFormRepository(SqliteBoardRepository board) {
        this.jdbc = board.jdbc();
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS question_forms (form_id TEXT PRIMARY KEY, board_id TEXT NOT NULL, project TEXT NOT NULL,
                  created_at INTEGER NOT NULL, lang TEXT NOT NULL, questions TEXT NOT NULL)""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS question_forms_board ON question_forms(board_id)");
    }

    @Override
    public void saveForm(QuestionForm form) {
        try {
            jdbc.update("INSERT OR REPLACE INTO question_forms(form_id, board_id, project, created_at, lang, questions) VALUES (?,?,?,?,?,?)",
                    form.id(), form.boardId(), form.project(), form.createdAt().toEpochMilli(), form.lang(), JSON.writeValueAsString(form.questions()));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("A questions form could not be written", e);
        }
    }

    @Override
    public Optional<QuestionForm> findForm(String id) {
        if (id == null || id.isBlank() || id.length() > 64) {
            return Optional.empty();
        }
        return jdbc.query("SELECT form_id, board_id, project, created_at, lang, questions FROM question_forms WHERE form_id = ?", (rs, n) -> {
            try {
                return new QuestionForm(rs.getString(1), rs.getString(2), rs.getString(3), Instant.ofEpochMilli(rs.getLong(4)), rs.getString(5),
                        JSON.readValue(rs.getString(6), ITEMS));
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new IllegalStateException("A stored questions form does not read", e);
            }
        }, id).stream().findFirst();
    }
}
