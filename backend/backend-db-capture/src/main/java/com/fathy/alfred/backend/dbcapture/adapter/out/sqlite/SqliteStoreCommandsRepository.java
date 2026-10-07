package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.dbcapture.application.port.out.StoreCommandsPort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreGroup;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreOrigin;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayOutputStream;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Store commands in db-capture.db (specs/011-redis-capture research R9) - sharing the statement adapter's pool and
 * transactions, so a call's statements and commands are deleted together. Rows never hold bytes; list reads name their
 * columns and never touch {@code store_command_data}. Ingest is idempotent on the agent's command id.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.db-capture", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteStoreCommandsRepository implements StoreCommandsPort {

    private static final Logger log = LoggerFactory.getLogger(SqliteStoreCommandsRepository.class);
    private static final int IN_CHUNK = 400;
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() { };

    static final String ROW_COLUMNS = "id, store, seq, at, micros, command, keys_json, keys_total, key_pattern, rw, outcome, reply_type, "
            + "reply_preview, args_text, error, origin_json, group_kind, group_id, group_index, group_size, code, client, connection, "
            + "pool_wait_us, bytes, reply_bytes, before_bytes, before_note, run_tag";

    private final ObjectMapper objectMapper;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    public SqliteStoreCommandsRepository(SqliteDbCaptureRepository statements, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        this.jdbc = statements.jdbc();
        this.transactions = statements.transactions();
    }

    // ------------------------------------------------------------------ ingest

    @Override
    public void save(List<NewCommand> commands) {
        if (commands.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        transactions.executeWithoutResult(status -> {
            for (NewCommand n : commands) {
                IncomingStoreCommand c = n.command();
                int inserted = jdbc.update("""
                        INSERT OR IGNORE INTO store_commands (agent_sid, store, project, call_id, run_tag, seq, at, at_ms, micros, command,
                          keys_json, keys_total, key_pattern, rw, outcome, reply_type, resp, error, args_bytes, reply_bytes, before_bytes, bytes,
                          reply_preview, args_text, client, connection, server, db_index, thread, code, callers_json, origin_json,
                          group_kind, group_id, group_index, group_size, pool_wait_us, before_type, before_note, fingerprint, chunked, complete,
                          received_ms)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        c.sid(), c.store(), n.project(), c.callId(), c.runTag(), c.seq(), c.at(), atMs(c.at()), c.micros(), c.command(),
                        json(c.keys()), Math.max(c.keysTotal(), c.keys().size()), n.keyPattern(), n.rw(), n.outcome(),
                        c.replyType() == null ? "NONE" : c.replyType(), c.resp(), c.error(), size(c.argsBytes(), c.args()),
                        size(c.replyBytes(), c.reply()), size(c.beforeBytes(), c.before()),
                        size(c.argsBytes(), c.args()) + size(c.replyBytes(), c.reply()) + size(c.beforeBytes(), c.before()),
                        n.replyPreview(), n.argsText(), c.client(), c.connection(), c.server(), c.db(), c.thread(), c.code(),
                        c.callers().isEmpty() ? null : json(c.callers()), c.origin() == null ? null : json(c.origin()),
                        c.group() == null ? null : c.group().kind(), c.group() == null ? null : c.group().id(),
                        c.group() == null ? null : c.group().index(), c.group() == null ? null : c.group().size(),
                        c.poolWaitMicros(), c.beforeType(), c.beforeNote(), c.fingerprint(), c.chunked() ? 1 : 0, c.chunked() ? 0 : 1, now);
                if (inserted == 0) {
                    continue; // a batch the agent retried
                }
                putData(c.sid(), "args", c.args(), now);
                putData(c.sid(), "reply", c.reply(), now);
                putData(c.sid(), "before", c.before(), now);
                if (!c.chunked()) {
                    insertKeys(n.keys());
                }
            }
        });
    }

    private void putData(String sid, String which, byte[] data, long now) {
        if (data != null && data.length > 0) {
            jdbc.update("INSERT OR IGNORE INTO store_command_data (sid, which, part, of_parts, data, received_ms) VALUES (?,?,0,1,?,?)",
                    sid, which, data, now);
        }
    }

    private void insertKeys(List<StoredKey> keys) {
        if (keys == null || keys.isEmpty()) {
            return;
        }
        jdbc.batchUpdate("INSERT INTO store_keys (project, key, call_id, seq, op, at_ms, value_hash, ttl_ms) VALUES (?,?,?,?,?,?,?,?)",
                keys.stream().map(k -> new Object[]{k.project(), k.key(), k.callId(), k.seq(), k.op(), k.atMs(), k.valueHash(), k.ttlMs()})
                        .collect(Collectors.toList()));
    }

    @Override
    public void saveChunks(List<IncomingStoreChunk> chunks) {
        if (chunks.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        jdbc.batchUpdate("INSERT OR IGNORE INTO store_command_data (sid, which, part, of_parts, data, received_ms) VALUES (?,?,?,?,?,?)",
                chunks.stream().map(c -> new Object[]{c.sid(), c.which(), c.part(), c.of(), c.data(), now}).collect(Collectors.toList()));
    }

    @Override
    public Optional<IncomingStoreCommand> completeChunked(String sid) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT args_bytes, reply_bytes, before_bytes FROM store_commands WHERE agent_sid = ? AND complete = 0 LIMIT 1", sid);
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Map<String, Object> row = rows.get(0);
        Map<String, byte[]> parts = new LinkedHashMap<>();
        for (String which : List.of("args", "reply", "before")) {
            long expected = ((Number) row.get(which + "_bytes")).longValue();
            if (expected == 0) {
                continue;
            }
            byte[] bytes = assembled(sid, which);
            if (bytes == null || bytes.length != expected) {
                return Optional.empty();
            }
            parts.put(which, bytes);
        }
        return incoming(sid).map(c -> c.withBytes(parts.get("args"), parts.get("reply"), parts.get("before")));
    }

    /** The parts of one {@code which}, in order - null while any is missing. */
    private byte[] assembled(String sid, String which) {
        List<Map<String, Object>> parts = jdbc.queryForList(
                "SELECT part, of_parts, data FROM store_command_data WHERE sid = ? AND which = ? ORDER BY part LIMIT 100000", sid, which);
        if (parts.isEmpty()) {
            return null;
        }
        int of = ((Number) parts.get(0).get("of_parts")).intValue();
        if (parts.size() != of) {
            return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (Map<String, Object> p : parts) {
            byte[] data = (byte[]) p.get("data");
            out.write(data, 0, data.length);
        }
        return out.toByteArray();
    }

    private Optional<IncomingStoreCommand> incoming(String sid) {
        List<IncomingStoreCommand> found = jdbc.query("""
                SELECT store, agent_sid, call_id, run_tag, seq, at, micros, command, keys_json, keys_total, reply_type, resp, error,
                       args_bytes, reply_bytes, before_bytes, client, connection, server, db_index, thread, code, callers_json, origin_json,
                       group_kind, group_id, group_index, group_size, pool_wait_us, before_type, before_note, fingerprint
                FROM store_commands WHERE agent_sid = ? LIMIT 1""", (rs, i) -> new IncomingStoreCommand(rs.getString("store"),
                rs.getString("agent_sid"), rs.getString("call_id"), rs.getString("run_tag"), rs.getInt("seq"), rs.getString("at"),
                rs.getLong("micros"), rs.getString("command"), strings(rs.getString("keys_json")), rs.getInt("keys_total"), null, null,
                rs.getString("reply_type"), rs.getInt("resp"), rs.getString("error"), rs.getLong("args_bytes"), rs.getLong("reply_bytes"),
                true, rs.getString("client"), rs.getString("connection"), rs.getString("server"), rs.getInt("db_index"), rs.getString("thread"),
                rs.getString("code"), strings(rs.getString("callers_json")), origin(rs.getString("origin_json")), group(rs),
                longOrNull(rs, "pool_wait_us"), null, rs.getString("before_type"), rs.getString("before_note"), rs.getLong("before_bytes"),
                rs.getString("fingerprint")), sid);
        return found.stream().findFirst();
    }

    @Override
    public void finishChunked(String sid, NewCommand derived) {
        transactions.executeWithoutResult(status -> {
            int done = jdbc.update("UPDATE store_commands SET complete = 1, outcome = ?, reply_preview = ?, args_text = ?, key_pattern = ?, rw = ?, "
                            + "project = COALESCE(project, ?) WHERE agent_sid = ? AND complete = 0",
                    derived.outcome(), derived.replyPreview(), derived.argsText(), derived.keyPattern(), derived.rw(), derived.project(), sid);
            if (done > 0) {
                insertKeys(derived.keys());
            }
        });
    }

    @Override
    public void openCall(String callId, String project, String firstSeen) {
        jdbc.update("INSERT OR IGNORE INTO call_store_summary (call_id, project, first_seen) VALUES (?,?,?)", callId, project, firstSeen);
    }

    @Override
    public void addDropped(Map<String, Long> droppedByCall) {
        if (droppedByCall == null) {
            return;
        }
        String now = java.time.Instant.now().toString();
        droppedByCall.forEach((callId, n) -> {
            jdbc.update("INSERT OR IGNORE INTO call_store_summary (call_id, first_seen) VALUES (?,?)", callId, now);
            jdbc.update("UPDATE call_store_summary SET dropped = dropped + ? WHERE call_id = ?", n, callId);
        });
    }

    @Override
    public void refreshSummary(String callId) {
        String now = java.time.Instant.now().toString();
        transactions.executeWithoutResult(status -> {
            jdbc.update("INSERT OR IGNORE INTO call_store_summary (call_id, project, first_seen) "
                    + "SELECT call_id, project, ? FROM store_commands WHERE call_id = ? LIMIT 1", now, callId);
            jdbc.update("""
                    UPDATE call_store_summary SET
                      project = COALESCE(project, (SELECT project FROM store_commands WHERE call_id = ?1 AND project IS NOT NULL LIMIT 1)),
                      commands = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1),
                      reads = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1 AND rw = 'r'),
                      writes = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1 AND rw = 'w'),
                      hits = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1 AND outcome = 'HIT'),
                      misses = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1 AND outcome = 'MISS'),
                      failed = (SELECT COUNT(*) FROM store_commands WHERE call_id = ?1 AND complete = 1 AND outcome = 'FAILED'),
                      micros = (SELECT COALESCE(SUM(micros), 0) FROM store_commands WHERE call_id = ?1 AND complete = 1),
                      bytes = (SELECT COALESCE(SUM(bytes), 0) FROM store_commands WHERE call_id = ?1)
                    WHERE call_id = ?1""", callId);
        });
    }

    @Override
    public void markComplete(String callId, boolean endedEarly) {
        jdbc.update("UPDATE call_store_summary SET complete = 1, ended_early = ? WHERE call_id = ?", endedEarly ? 1 : 0, callId);
    }

    // ------------------------------------------------------------------ reads

    @Override
    public int count(String callId) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM store_commands WHERE call_id = ? AND complete = 1", Integer.class, callId);
        return n == null ? 0 : n;
    }

    @Override
    public List<StoreCommandSummary> commands(String callId, int offset, int limit) {
        return jdbc.query("SELECT " + ROW_COLUMNS + " FROM store_commands WHERE call_id = ? AND complete = 1 ORDER BY seq LIMIT ? OFFSET ?",
                summaryMapper(), callId, limit, offset);
    }

    @Override
    public Optional<StoredCommand> command(long id) {
        List<StoredCommand> found = jdbc.query("SELECT " + ROW_COLUMNS + ", agent_sid, project, call_id, server, db_index, thread, callers_json, "
                + "fingerprint, resp, before_type FROM store_commands WHERE id = ? AND complete = 1", storedMapper(), id);
        return found.stream().findFirst();
    }

    @Override
    public List<StoredCommand> commandsWithBytes(String callId, int limit) {
        return jdbc.query("SELECT " + ROW_COLUMNS + ", agent_sid, project, call_id, server, db_index, thread, callers_json, fingerprint, "
                + "resp, before_type FROM store_commands WHERE call_id = ? AND complete = 1 ORDER BY seq LIMIT ?", storedMapper(), callId, limit);
    }

    private RowMapper<StoredCommand> storedMapper() {
        RowMapper<StoreCommandSummary> row = summaryMapper();
        return (rs, i) -> {
            String sid = rs.getString("agent_sid");
            return new StoredCommand(row.mapRow(rs, i), rs.getString("project"), rs.getString("call_id"), assembled(sid, "args"),
                    assembled(sid, "reply"), assembled(sid, "before"), rs.getString("server"), rs.getInt("db_index"), rs.getString("thread"),
                    strings(rs.getString("callers_json")), rs.getString("fingerprint"), rs.getInt("resp"), rs.getString("before_type"));
        };
    }

    private RowMapper<StoreCommandSummary> summaryMapper() {
        return (rs, i) -> new StoreCommandSummary(rs.getLong("id"), rs.getString("store"), rs.getInt("seq"), rs.getString("at"),
                rs.getLong("micros"), rs.getString("command"), strings(rs.getString("keys_json")), rs.getInt("keys_total"),
                rs.getString("key_pattern"), rs.getString("rw"), rs.getString("outcome"), rs.getString("reply_type"),
                rs.getString("reply_preview"), rs.getString("args_text"), rs.getString("error"), origin(rs.getString("origin_json")),
                group(rs), rs.getString("code"), rs.getString("client"), rs.getString("connection"), longOrNull(rs, "pool_wait_us"),
                rs.getLong("bytes"), rs.getLong("reply_bytes"), rs.getLong("before_bytes") > 0 || rs.getString("before_note") != null,
                rs.getString("before_note"), rs.getString("run_tag"));
    }

    @Override
    public Map<String, CallStoreSummary> summaries(Collection<String> callIds) {
        Map<String, CallStoreSummary> out = new LinkedHashMap<>();
        inChunks(callIds, (in, args) -> jdbc.query("SELECT call_id, project, commands, reads, writes, hits, misses, failed, micros, dropped, complete, "
                + "ended_early FROM call_store_summary WHERE call_id IN (" + in + ")", rs -> {
            out.put(rs.getString("call_id"), new CallStoreSummary(rs.getString("call_id"), rs.getString("project"), rs.getInt("commands"),
                    rs.getInt("reads"), rs.getInt("writes"), rs.getInt("hits"), rs.getInt("misses"), rs.getInt("failed"), rs.getLong("micros"),
                    rs.getLong("dropped"), rs.getInt("complete") == 0, rs.getInt("ended_early") != 0));
        }, args));
        return out;
    }

    @Override
    public List<String> failedCallIds(Collection<String> callIds) {
        List<String> out = new ArrayList<>();
        inChunks(callIds, (in, args) -> out.addAll(jdbc.queryForList(
                "SELECT call_id FROM call_store_summary WHERE failed > 0 AND call_id IN (" + in + ")", String.class, args)));
        return out;
    }

    @Override
    public List<StoredKey> keysOfCall(String callId) {
        return jdbc.query("SELECT project, key, call_id, seq, op, at_ms, value_hash, ttl_ms FROM store_keys WHERE call_id = ? ORDER BY seq LIMIT 20000",
                keyMapper(), callId);
    }

    @Override
    public Optional<StoredKey> latestWrite(String project, String key, long beforeAtMs) {
        return jdbc.query("SELECT project, key, call_id, seq, op, at_ms, value_hash, ttl_ms FROM store_keys "
                        + "WHERE project IS ? AND key = ? AND at_ms < ? AND op = 'w' ORDER BY at_ms DESC, seq DESC LIMIT 1",
                keyMapper(), project, key, beforeAtMs).stream().findFirst();
    }

    @Override
    public List<StoredKey> keyHistory(String project, String key, int limit) {
        return jdbc.query("SELECT project, key, call_id, seq, op, at_ms, value_hash, ttl_ms FROM store_keys WHERE project IS ? AND key = ? "
                + "ORDER BY at_ms DESC, seq DESC LIMIT ?", keyMapper(), project, key, limit);
    }

    private static RowMapper<StoredKey> keyMapper() {
        return (rs, i) -> new StoredKey(rs.getString("project"), rs.getString("key"), rs.getString("call_id"), rs.getInt("seq"), rs.getString("op"),
                rs.getLong("at_ms"), rs.getString("value_hash"), longOrNull(rs, "ttl_ms"));
    }

    @Override
    public Optional<String> projectOf(String callId) {
        return jdbc.queryForList("SELECT project FROM call_store_summary WHERE call_id = ? AND project IS NOT NULL "
                        + "UNION ALL SELECT project FROM store_commands WHERE call_id = ? AND project IS NOT NULL LIMIT 1",
                String.class, callId, callId).stream().findFirst();
    }

    // ------------------------------------------------------------------ retention

    @Override
    public int deleteForCalls(Collection<String> callIds) {
        int[] deleted = {0};
        inChunks(callIds, (in, args) -> transactions.executeWithoutResult(status ->
                deleted[0] += StoreCommandsSchema.deleteForCalls(jdbc, in, args)));
        return deleted[0];
    }

    @Override
    public void deleteAll() {
        transactions.executeWithoutResult(status -> StoreCommandsSchema.deleteAll(jdbc));
    }

    @Override
    public long bytes() {
        Long a = jdbc.queryForObject("SELECT COALESCE(SUM(bytes), 0) FROM store_commands", Long.class);
        Long orphan = jdbc.queryForObject("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM store_command_data d "
                + "WHERE NOT EXISTS (SELECT 1 FROM store_commands c WHERE c.agent_sid = d.sid)", Long.class);
        return (a == null ? 0 : a) + (orphan == null ? 0 : orphan);
    }

    @Override
    public List<String> oldestCallIds(int limit, Set<String> keep) {
        List<String> out = new ArrayList<>();
        int offset = 0;
        while (out.size() < limit) {
            List<String> page = jdbc.queryForList("SELECT call_id FROM call_store_summary WHERE bytes > 0 ORDER BY first_seen LIMIT ? OFFSET ?",
                    String.class, limit * 2, offset);
            if (page.isEmpty()) {
                break;
            }
            offset += page.size();
            for (String id : page) {
                if (!keep.contains(id) && out.size() < limit) {
                    out.add(id);
                }
            }
        }
        return out;
    }

    @Override
    public int purgeIncomplete(long olderThanMs) {
        int[] purged = {0};
        transactions.executeWithoutResult(status -> {
            List<Map<String, Object>> stale = jdbc.queryForList(
                    "SELECT agent_sid, call_id FROM store_commands WHERE complete = 0 AND received_ms < ? LIMIT 1000", olderThanMs);
            for (Map<String, Object> s : stale) {
                jdbc.update("DELETE FROM store_command_data WHERE sid = ?", s.get("agent_sid"));
                jdbc.update("DELETE FROM store_commands WHERE agent_sid = ?", s.get("agent_sid"));
                jdbc.update("UPDATE call_store_summary SET dropped = dropped + 1 WHERE call_id = ?", s.get("call_id"));
                purged[0]++;
            }
            // parts whose record never came
            jdbc.update("DELETE FROM store_command_data WHERE received_ms < ? AND NOT EXISTS "
                    + "(SELECT 1 FROM store_commands c WHERE c.agent_sid = store_command_data.sid)", olderThanMs);
        });
        if (purged[0] > 0) {
            log.warn("Removed {} Redis commands whose parts never all arrived", purged[0]);
        }
        return purged[0];
    }

    // ------------------------------------------------------------------ helpers

    private interface ChunkQuery {
        void run(String in, Object[] args);
    }

    private static void inChunks(Collection<String> ids, ChunkQuery query) {
        List<String> all = ids == null ? List.of() : new ArrayList<>(ids);
        for (int i = 0; i < all.size(); i += IN_CHUNK) {
            List<String> chunk = all.subList(i, Math.min(all.size(), i + IN_CHUNK));
            query.run(chunk.stream().map(x -> "?").collect(Collectors.joining(",")), chunk.toArray());
        }
    }

    private static long size(long declared, byte[] data) {
        return data != null ? data.length : Math.max(0, declared);
    }

    private static long atMs(String at) {
        return com.fathy.alfred.backend.dbcapture.domain.StoreCommandFacts.atMs(at);
    }

    private String json(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private List<String> strings(String json) {
        if (json == null || json.isEmpty()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, STRINGS);
        } catch (JsonProcessingException e) {
            return List.of();
        }
    }

    private StoreOrigin origin(String json) {
        if (json == null) {
            return null;
        }
        try {
            return objectMapper.readValue(json, StoreOrigin.class);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static StoreGroup group(ResultSet rs) throws SQLException {
        String kind = rs.getString("group_kind");
        return kind == null ? null : new StoreGroup(kind, rs.getString("group_id"), rs.getInt("group_index"), rs.getInt("group_size"));
    }

    private static Long longOrNull(ResultSet rs, String column) throws SQLException {
        long v = rs.getLong(column);
        return rs.wasNull() ? null : v;
    }
}
