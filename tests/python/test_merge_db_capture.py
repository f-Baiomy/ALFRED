"""scripts/merge_db_capture.py: captures of one db-capture.db land in another under the same call ids, nothing collides."""

import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import merge_db_capture  # noqa: E402

SCHEMA = """
CREATE TABLE statements (id INTEGER PRIMARY KEY, agent_sid TEXT NOT NULL UNIQUE, call_id TEXT, thread_name TEXT NOT NULL,
  seq INTEGER NOT NULL, kind TEXT NOT NULL, sql TEXT NOT NULL, params_json TEXT NOT NULL, outcome_json TEXT NOT NULL,
  started_at TEXT NOT NULL, duration_us INTEGER NOT NULL, offset_us INTEGER NOT NULL);
CREATE TABLE result_rows (statement_id INTEGER NOT NULL, part TEXT NOT NULL, row_index INTEGER NOT NULL, values_json TEXT NOT NULL,
  PRIMARY KEY (statement_id, part, row_index)) WITHOUT ROWID;
CREATE TABLE transactions (call_id TEXT NOT NULL, tx_id TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
  outcome TEXT NOT NULL, held_us INTEGER NOT NULL, statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL, PRIMARY KEY (call_id, tx_id));
CREATE TABLE call_markers (call_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (call_id, seq)) WITHOUT ROWID;
CREATE TABLE call_db_summary (call_id TEXT PRIMARY KEY, statement_count INTEGER NOT NULL, write_count INTEGER NOT NULL);
CREATE TABLE call_log_lines (id INTEGER PRIMARY KEY, call_id TEXT, seq INTEGER NOT NULL, at TEXT NOT NULL, at_ms INTEGER NOT NULL,
  level TEXT, logger TEXT, thread TEXT, message TEXT, exception_json TEXT, cut INTEGER NOT NULL DEFAULT 0, project TEXT, approx_bytes INTEGER NOT NULL);
CREATE TABLE call_log_summary (call_id TEXT PRIMARY KEY, lines INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0);
CREATE TABLE call_store_summary (call_id TEXT PRIMARY KEY, commands INTEGER NOT NULL DEFAULT 0);
CREATE TABLE store_commands (id INTEGER PRIMARY KEY, agent_sid TEXT NOT NULL UNIQUE, store TEXT NOT NULL, call_id TEXT NOT NULL,
  seq INTEGER NOT NULL, at_ms INTEGER NOT NULL, micros INTEGER NOT NULL, command TEXT NOT NULL, keys_json TEXT NOT NULL,
  keys_total INTEGER NOT NULL, rw TEXT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE store_command_data (sid TEXT NOT NULL, which TEXT NOT NULL, part INTEGER NOT NULL, of_parts INTEGER NOT NULL,
  data BLOB NOT NULL, received_ms INTEGER NOT NULL, PRIMARY KEY (sid, which, part));
CREATE TABLE store_keys (project TEXT, key TEXT NOT NULL, call_id TEXT NOT NULL, seq INTEGER NOT NULL, op TEXT NOT NULL, at_ms INTEGER NOT NULL);
CREATE TABLE capture_settings (project TEXT PRIMARY KEY, settings_json TEXT NOT NULL);
CREATE TABLE agents (agent_id TEXT PRIMARY KEY, project TEXT NOT NULL, status_json TEXT NOT NULL, last_seen TEXT NOT NULL);
"""
FTS = """
CREATE VIRTUAL TABLE call_log_text USING fts5(message, logger, thread, exception, content='', contentless_delete=1, tokenize='trigram');
"""
TRIGGER = """
CREATE TRIGGER call_log_text_ai AFTER INSERT ON call_log_lines BEGIN
  INSERT INTO call_log_text(rowid, message, logger, thread, exception) VALUES (new.id, new.message, new.logger, new.thread, new.exception_json); END;
"""


def statement(con, sid, call, seq, rows=1):
    cur = con.execute("INSERT INTO statements (agent_sid, call_id, thread_name, seq, kind, sql, params_json, outcome_json, started_at, "
                      "duration_us, offset_us) VALUES (?,?,?,?,?,?,?,?,?,?,?)", (sid, call, "t", seq, "SELECT", "SELECT 1", "[]", "{}", "2026", 1, 0))
    for i in range(rows):
        con.execute("INSERT INTO result_rows VALUES (?,?,?,?)", (cur.lastrowid, "RESULT", i, "[]"))
    return cur.lastrowid


def log_line(con, call, seq, message):
    con.execute("INSERT INTO call_log_lines (call_id, seq, at, at_ms, level, logger, thread, message, approx_bytes) VALUES (?,?,?,?,?,?,?,?,?)",
                (call, seq, "2026", 1, "ERROR", "L", "t", message, 10))


class MergeTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="alfred-merge-test-")
        self.source = os.path.join(self.tmp, "source.db")
        self.target = os.path.join(self.tmp, "target.db")
        self.fts = True
        for path in (self.source, self.target):
            con = sqlite3.connect(path)
            con.executescript(SCHEMA)
            try:
                con.executescript(FTS)
            except sqlite3.OperationalError:
                self.fts = False
            con.commit()
            con.close()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fill(self):
        src = sqlite3.connect(self.source)
        statement(src, "docker:1", "call-old", 1, rows=2)
        statement(src, "docker:2", "call-old", 2)
        statement(src, "both:1", "call-both", 1)
        src.execute("INSERT INTO transactions VALUES ('call-old','tx-1',1,2,'COMMITTED',5,2,0)")
        src.execute("INSERT INTO call_markers VALUES ('call-old',0,'CALL_OPEN','2026')")
        src.execute("INSERT INTO call_db_summary VALUES ('call-old',2,0)")
        src.execute("INSERT INTO call_db_summary VALUES ('call-both',99,99)")
        log_line(src, "call-old", 1, "payment failed badly")
        src.execute("INSERT INTO call_log_summary VALUES ('call-old',1,1)")
        src.execute("INSERT INTO store_commands (agent_sid, store, call_id, seq, at_ms, micros, command, keys_json, keys_total, rw, outcome) "
                    "VALUES ('docker:r1','redis','call-old',3,1,1,'GET','[]',1,'r','OK')")
        src.execute("INSERT INTO store_command_data VALUES ('docker:r1','reply',1,1,X'00',1)")
        src.execute("INSERT INTO store_keys VALUES ('odeysys','k','call-old',3,'GET',1)")
        src.execute("INSERT INTO call_store_summary VALUES ('call-old',1)")
        src.execute("INSERT INTO capture_settings VALUES ('odeysys','{}')")
        src.execute("INSERT INTO agents VALUES ('odeysys-1','odeysys','{}','2026')")
        src.commit()
        src.close()
        tgt = sqlite3.connect(self.target)
        statement(tgt, "native:1", "call-new", 1)           # id 1 in the target: the source's ids must move past it
        statement(tgt, "both:1", "call-both", 1)             # the same agent statement on both sides: kept once
        tgt.execute("INSERT INTO call_db_summary VALUES ('call-both',1,0)")
        log_line(tgt, "call-new", 1, "hello")
        tgt.commit()
        tgt.close()

    def test_captures_land_under_their_calls_without_colliding(self):
        self.fill()
        copied = merge_db_capture.merge(self.source, self.target, log=lambda *a: None)
        self.assertEqual(2, copied["statements"])
        self.assertEqual(3, copied["result_rows"])
        self.assertEqual(1, copied["call_log_lines"])
        self.assertEqual(1, copied["store_commands"])
        tgt = sqlite3.connect(self.target)
        # the target's own statement 1 is untouched and the copied ones sit past it, rows following their statement
        self.assertEqual([(1, "native:1"), (2, "both:1"), (3, "docker:1"), (4, "docker:2")],
                         tgt.execute("SELECT id, agent_sid FROM statements ORDER BY id").fetchall())
        self.assertEqual(2, tgt.execute("SELECT count(*) FROM result_rows WHERE statement_id = 3").fetchone()[0])
        # the statement both sides had keeps the target's single row - the source's copy of it was not added again
        self.assertEqual(1, tgt.execute("SELECT count(*) FROM result_rows WHERE statement_id = 2").fetchone()[0])
        # a summary the target already had is kept as it was
        self.assertEqual((1, 0), tgt.execute("SELECT statement_count, write_count FROM call_db_summary WHERE call_id = 'call-both'").fetchone())
        self.assertEqual((2, 0), tgt.execute("SELECT statement_count, write_count FROM call_db_summary WHERE call_id = 'call-old'").fetchone())
        self.assertEqual([(1, "call-new"), (2, "call-old")], tgt.execute("SELECT id, call_id FROM call_log_lines ORDER BY id").fetchall())
        if self.fts:
            # the copied line is searchable: no trigger on this target, so the script indexed it itself
            self.assertEqual([(2,)], tgt.execute("SELECT rowid FROM call_log_text WHERE call_log_text MATCH 'failed'").fetchall())
            self.assertEqual(1, tgt.execute("SELECT count(*) FROM call_log_text").fetchone()[0])
        self.assertEqual(1, tgt.execute("SELECT count(*) FROM store_command_data").fetchone()[0])
        self.assertEqual(1, tgt.execute("SELECT count(*) FROM agents").fetchone()[0])
        tgt.close()

    def test_running_twice_adds_nothing_and_a_dry_run_writes_nothing(self):
        self.fill()
        dry = merge_db_capture.merge(self.source, self.target, dry_run=True, log=lambda *a: None)
        self.assertEqual(2, dry["statements"])
        self.assertEqual(2, sqlite3.connect(self.target).execute("SELECT count(*) FROM statements").fetchone()[0])
        merge_db_capture.merge(self.source, self.target, log=lambda *a: None)
        again = merge_db_capture.merge(self.source, self.target, log=lambda *a: None)
        self.assertEqual({t: 0 for t in again}, again)

    def test_a_target_with_backends_trigger_indexes_once(self):
        if not self.fts:
            self.skipTest("no FTS5 in this sqlite")
        tgt = sqlite3.connect(self.target)
        tgt.executescript(TRIGGER)
        tgt.commit()
        tgt.close()
        self.fill()
        merge_db_capture.merge(self.source, self.target, log=lambda *a: None)
        tgt = sqlite3.connect(self.target)
        self.assertEqual(2, tgt.execute("SELECT count(*) FROM call_log_text").fetchone()[0])  # hello + the copied line, once each
        self.assertEqual([(2,)], tgt.execute("SELECT rowid FROM call_log_text WHERE call_log_text MATCH 'failed'").fetchall())

    def test_a_target_without_the_tables_is_refused(self):
        empty = os.path.join(self.tmp, "empty.db")
        sqlite3.connect(empty).close()
        with self.assertRaises(SystemExit) as refused:
            merge_db_capture.merge(self.source, empty, log=lambda *a: None)
        self.assertIn("statements", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
