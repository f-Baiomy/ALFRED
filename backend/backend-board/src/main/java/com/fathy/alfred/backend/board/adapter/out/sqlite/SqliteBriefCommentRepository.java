package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fathy.alfred.backend.board.application.port.out.BriefCommentStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BriefComment;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Component;

import java.sql.PreparedStatement;
import java.sql.Statement;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * A cycle brief's comments (specs/024) in board.db, through the board repository's connection pool - the table is made
 * there, so a cycle's removal deletes them in the same transaction as the brief. An unknown actor reads as the user.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.board", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteBriefCommentRepository implements BriefCommentStorePort {

    private static final String COLUMNS = "id, cycle_id, quote, actor, text, reply_to, asks, suggest_from, suggest_to, created_at, "
            + "resolved_at, resolved_by";

    private final JdbcTemplate jdbc;

    public SqliteBriefCommentRepository(SqliteBoardRepository board) {
        this.jdbc = board.jdbc();
    }

    private static Actor actor(String s) {
        if (s == null) {
            return null;
        }
        try {
            return Actor.valueOf(s);
        } catch (IllegalArgumentException e) {
            return Actor.USER;
        }
    }

    private static Instant instant(java.sql.ResultSet rs, int col) throws java.sql.SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : Instant.ofEpochMilli(v);
    }

    private final RowMapper<BriefComment> row = (rs, n) -> {
        long replyTo = rs.getLong(6);
        Long reply = rs.wasNull() ? null : replyTo;
        return new BriefComment(rs.getLong(1), rs.getString(2), rs.getString(3), actor(rs.getString(4)), rs.getString(5), reply,
                rs.getInt(7) != 0, rs.getString(8), rs.getString(9), instant(rs, 10), instant(rs, 11), actor(rs.getString(12)));
    };

    @Override
    public List<BriefComment> briefComments(String cycleId) {
        return jdbc.query("SELECT " + COLUMNS + " FROM brief_comments WHERE cycle_id = ? ORDER BY id LIMIT 5000", row, cycleId);
    }

    @Override
    public Optional<BriefComment> briefComment(long id) {
        return jdbc.query("SELECT " + COLUMNS + " FROM brief_comments WHERE id = ?", row, id).stream().findFirst();
    }

    @Override
    public long addBriefComment(BriefComment c) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement("INSERT INTO brief_comments(cycle_id, quote, actor, text, reply_to, asks, "
                    + "suggest_from, suggest_to, created_at, resolved_at, resolved_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, c.cycleId());
            ps.setString(2, c.quote());
            ps.setString(3, c.actor().name());
            ps.setString(4, c.text());
            if (c.replyTo() == null) {
                ps.setNull(5, Types.INTEGER);
            } else {
                ps.setLong(5, c.replyTo());
            }
            ps.setInt(6, c.asks() ? 1 : 0);
            ps.setString(7, c.suggestFrom());
            ps.setString(8, c.suggestTo());
            ps.setLong(9, c.createdAt().toEpochMilli());
            if (c.resolvedAt() == null) {
                ps.setNull(10, Types.INTEGER);
            } else {
                ps.setLong(10, c.resolvedAt().toEpochMilli());
            }
            ps.setString(11, c.resolvedBy() == null ? null : c.resolvedBy().name());
            return ps;
        }, keys);
        Number key = keys.getKey();
        return key == null ? jdbc.queryForObject("SELECT last_insert_rowid()", Long.class) : key.longValue();
    }

    @Override
    public boolean resolveBriefComment(long id, Instant at, Actor by) {
        return jdbc.update("UPDATE brief_comments SET resolved_at = ?, resolved_by = ? WHERE id = ?",
                at == null ? null : at.toEpochMilli(), at == null || by == null ? null : by.name(), id) > 0;
    }

    @Override
    public boolean clearBriefSuggestion(long id) {
        return jdbc.update("UPDATE brief_comments SET suggest_from = NULL, suggest_to = NULL WHERE id = ? AND suggest_to IS NOT NULL", id) > 0;
    }

    @Override
    public void requoteBriefComment(long id, String quote) {
        jdbc.update("UPDATE brief_comments SET quote = ? WHERE id = ?", quote, id);
    }
}
