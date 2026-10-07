package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The store-command tables in db-capture.db (specs/011-redis-capture data-model.md) - created with the statement
 * tables, so deleting a call removes both in one transaction. Rows never carry bytes: they live in
 * {@code store_command_data} (keyed by the agent's command id, so parts that arrive before their record are kept) and
 * are read only for a command's detail and for exports.
 */
final class StoreCommandsSchema {

    private StoreCommandsSchema() {
    }

    static void create(JdbcTemplate jdbc) {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS store_commands (
                  id INTEGER PRIMARY KEY,
                  agent_sid TEXT NOT NULL UNIQUE,
                  store TEXT NOT NULL, project TEXT, call_id TEXT NOT NULL, run_tag TEXT,
                  seq INTEGER NOT NULL, at TEXT, at_ms INTEGER NOT NULL, micros INTEGER NOT NULL,
                  command TEXT NOT NULL, keys_json TEXT NOT NULL, keys_total INTEGER NOT NULL, key_pattern TEXT,
                  rw TEXT NOT NULL, outcome TEXT NOT NULL, reply_type TEXT NOT NULL, resp INTEGER NOT NULL, error TEXT,
                  args_bytes INTEGER NOT NULL, reply_bytes INTEGER NOT NULL, before_bytes INTEGER NOT NULL, bytes INTEGER NOT NULL,
                  reply_preview TEXT, args_text TEXT,
                  client TEXT, connection TEXT, server TEXT, db_index INTEGER NOT NULL DEFAULT 0, thread TEXT, code TEXT,
                  callers_json TEXT, origin_json TEXT,
                  group_kind TEXT, group_id TEXT, group_index INTEGER, group_size INTEGER,
                  pool_wait_us INTEGER, before_type TEXT, before_note TEXT, fingerprint TEXT,
                  chunked INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 1, received_ms INTEGER NOT NULL
                )""");
        jdbc.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_store_call_seq ON store_commands(call_id, seq)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_at ON store_commands(at_ms)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_failed ON store_commands(call_id) WHERE outcome = 'FAILED'");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_run ON store_commands(run_tag) WHERE run_tag IS NOT NULL");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_fp ON store_commands(project, fingerprint)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_incomplete ON store_commands(received_ms) WHERE complete = 0");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS store_command_data (
                  sid TEXT NOT NULL, which TEXT NOT NULL, part INTEGER NOT NULL, of_parts INTEGER NOT NULL,
                  data BLOB NOT NULL, received_ms INTEGER NOT NULL,
                  PRIMARY KEY (sid, which, part)
                )""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_data_received ON store_command_data(received_ms)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS store_keys (
                  project TEXT, key TEXT NOT NULL, call_id TEXT NOT NULL, seq INTEGER NOT NULL, op TEXT NOT NULL,
                  at_ms INTEGER NOT NULL, value_hash TEXT, ttl_ms INTEGER
                )""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_keys_key_at ON store_keys(project, key, at_ms)");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_keys_call ON store_keys(call_id)");
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS call_store_summary (
                  call_id TEXT PRIMARY KEY, project TEXT,
                  commands INTEGER NOT NULL DEFAULT 0, reads INTEGER NOT NULL DEFAULT 0, writes INTEGER NOT NULL DEFAULT 0,
                  hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                  micros INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
                  complete INTEGER NOT NULL DEFAULT 0, ended_early INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL
                )""");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_summary_failed ON call_store_summary(failed) WHERE failed > 0");
        jdbc.execute("CREATE INDEX IF NOT EXISTS ix_store_summary_first_seen ON call_store_summary(first_seen)");
    }

    /** Every store row of these calls ({@code in}: "?,?,…" for {@code args}) - inside the caller's transaction. */
    static int deleteForCalls(JdbcTemplate jdbc, String in, Object[] args) {
        jdbc.update("DELETE FROM store_command_data WHERE sid IN (SELECT agent_sid FROM store_commands WHERE call_id IN (" + in + "))", args);
        int n = jdbc.update("DELETE FROM store_commands WHERE call_id IN (" + in + ")", args);
        jdbc.update("DELETE FROM store_keys WHERE call_id IN (" + in + ")", args);
        int summaries = jdbc.update("DELETE FROM call_store_summary WHERE call_id IN (" + in + ")", args);
        return n + (n == 0 ? summaries : 0);
    }

    static void deleteAll(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM store_command_data");
        jdbc.update("DELETE FROM store_commands");
        jdbc.update("DELETE FROM store_keys");
        jdbc.update("DELETE FROM call_store_summary");
    }
}
