#!/usr/bin/env python3
"""
merge_db_capture.py - copy the captures (statements, rows, transactions, log lines, Redis commands, summaries) of one
Alfred's db-capture.db into another's, keeping both sets.

Why this exists: the db-agent reports to ONE Alfred - the one its arguments named, or (since the proxy stamps
`alfred=` into X-Alfred-Call) the one whose reverse proxy delivers its calls. Before that stamp existed, an agent left
pointing at a Docker install kept sending every statement and log line there while a native install on another port
logged the calls themselves, so the calls and their captures ended up in two databases. This puts them back together:
call ids are the same on both sides (the reverse proxy made them), so every statement lands under its call.

    python scripts/merge_db_capture.py --source <db-capture.db of the other install> [--target C:\\alfred\\data\\db-capture.db] [--dry-run]
    python scripts/merge_db_capture.py --docker-volume alfred_db-capture-db [--target ...]      # source from a Docker volume

Stop Alfred first (`alfred stop`): the target is written in one transaction and must not be open elsewhere. Rows the
target already has (same agent statement id, same call summary) are left as they are; integer ids of the copied
statements, log lines and Redis commands are shifted past the target's own so nothing collides. The FTS index of log
lines fills itself through the target's own trigger. Idempotent: running it twice adds nothing the second time.
"""

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

# Tables copied as they are (same primary keys on both sides; OR IGNORE keeps the target's row when both have one).
PLAIN = ["transactions", "call_markers", "call_db_summary", "call_log_summary", "call_store_summary", "store_keys",
         "store_command_data", "capture_settings", "agents"]
# Tables whose INTEGER PRIMARY KEY is shifted past the target's highest id, and the columns that reference them.
SHIFTED = {"statements": ("id", [("result_rows", "statement_id")]), "call_log_lines": ("id", []), "store_commands": ("id", [])}
# What makes a row "already there" when its primary key says nothing (a shifted id, or no key at all): a second run
# must add nothing. Statements and Redis commands carry the agent's own unique id, so they need no rule.
NATURAL_KEYS = {"call_log_lines": ("call_id", "seq"), "store_keys": ("call_id", "seq", "key", "op")}


def columns(con, table, schema="main"):
    return [row[1] for row in con.execute(f"PRAGMA {schema}.table_info({table})")]


def count(con, table, schema="main"):
    return con.execute(f"SELECT count(*) FROM {schema}.{table}").fetchone()[0]


# What backend indexes of a log line's exception (SqliteDbCaptureRepository.LOG_EXCEPTION_TEXT) - kept identical.
LOG_EXCEPTION_TEXT = ("CASE WHEN exception_json IS NULL THEN NULL ELSE coalesce(json_extract(exception_json, '$.type'), '') || ' ' "
                      "|| coalesce(json_extract(exception_json, '$.message'), '') END")


def index_log_text(con, above_id):
    """The copied log lines into the trigram index. Backend's own AFTER INSERT trigger does it when the target was
    created by backend; a target without the trigger (a fresh copy of the schema) gets the same rows from here."""
    has_fts = con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'call_log_text'").fetchone()
    has_trigger = con.execute("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'call_log_text_ai'").fetchone()
    if has_fts and not has_trigger:
        con.execute("INSERT INTO call_log_text(rowid, message, logger, thread, exception) SELECT id, message, logger, thread, "
                    + LOG_EXCEPTION_TEXT + " FROM main.call_log_lines WHERE id > ?", (above_id,))


def not_there(table):
    """A WHERE clause skipping source rows the target already holds under their natural key (see NATURAL_KEYS)."""
    key = NATURAL_KEYS.get(table)
    if not key:
        return ""
    same = " AND ".join(f"t.{c} IS s.{c}" for c in key)
    return f" WHERE NOT EXISTS (SELECT 1 FROM main.{table} t WHERE {same})"


def fetch_from_docker_volume(volume, into):
    """Copies db-capture.db out of a Docker volume with a throwaway container (the volume's owner is root)."""
    subprocess.run(["docker", "run", "--rm", "-v", f"{volume}:/d:ro", "-v", f"{into}:/out", "alpine",
                    "sh", "-c", "cp /d/db-capture.db /out/db-capture.db"], check=True)
    return os.path.join(into, "db-capture.db")


def merge(source, target, dry_run=False, log=print):
    con = sqlite3.connect(target)
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("ATTACH DATABASE ? AS src", (source,))
    try:
        missing = [t for t in list(SHIFTED) + PLAIN if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (t,)).fetchone()]
        if missing:
            raise SystemExit(f"the target has no {', '.join(missing)} table(s) - start Alfred once on it first, then stop it and retry")
        before = {t: count(con, t) for t in list(SHIFTED) + ["result_rows"] + PLAIN}
        con.execute("BEGIN")
        copied = {}
        offsets = {}
        for table, (key, refs) in SHIFTED.items():
            offset = con.execute(f"SELECT COALESCE(MAX({key}), 0) FROM main.{table}").fetchone()[0]
            offsets[table] = offset
            cols = [c for c in columns(con, table, "src") if c in columns(con, table)]
            select = ", ".join(f"{c} + {offset}" if c == key else c for c in cols)
            con.execute(f"INSERT OR IGNORE INTO main.{table} ({', '.join(cols)}) SELECT {select} FROM src.{table} s{not_there(table)}")
            copied[table] = count(con, table) - before[table]
            if table == "call_log_lines":
                index_log_text(con, offset)
            for ref_table, ref_col in refs:
                ref_cols = [c for c in columns(con, ref_table, "src") if c in columns(con, ref_table)]
                select = ", ".join(f"{c} + {offset}" if c == ref_col else c for c in ref_cols)
                # only rows of statements that were actually copied (a duplicate agent id was ignored above)
                con.execute(f"INSERT OR IGNORE INTO main.{ref_table} ({', '.join(ref_cols)}) SELECT {select} FROM src.{ref_table} r "
                            f"WHERE EXISTS (SELECT 1 FROM main.{table} t WHERE t.{key} = r.{ref_col} + {offset})")
                copied[ref_table] = count(con, ref_table) - before[ref_table]
        for table in PLAIN:
            cols = [c for c in columns(con, table, "src") if c in columns(con, table)]
            con.execute(f"INSERT OR IGNORE INTO main.{table} ({', '.join(cols)}) SELECT {', '.join(cols)} FROM src.{table} s{not_there(table)}")
            copied[table] = count(con, table) - before[table]
        for table, n in copied.items():
            log(f"{table:20} {before[table]:>9} + {n:>8} copied")
        if dry_run:
            con.execute("ROLLBACK")
            log("dry run: nothing written")
        else:
            con.execute("COMMIT")
            log("done")
        return copied
    finally:
        con.close()


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", help="db-capture.db to copy from")
    parser.add_argument("--docker-volume", help="a Docker volume holding db-capture.db to copy from (e.g. alfred_db-capture-db)")
    parser.add_argument("--target", default=os.path.join(os.environ.get("ALFRED_HOME", r"C:\alfred" if os.name == "nt" else "/opt/alfred"),
                                                         "data", "db-capture.db"))
    parser.add_argument("--dry-run", action="store_true", help="show what would be copied, write nothing")
    args = parser.parse_args(argv)
    if bool(args.source) == bool(args.docker_volume):
        parser.error("give --source or --docker-volume (one of them)")
    if not os.path.isfile(args.target):
        parser.error(f"target {args.target} does not exist")
    control = os.path.join(os.path.dirname(os.path.dirname(args.target)), "data", "run", "control.json")
    if os.path.exists(control) and not args.dry_run:
        parser.error("Alfred seems to be running (data/run/control.json exists) - stop it first: alfred stop")
    tmp = None
    try:
        source = args.source
        if args.docker_volume:
            tmp = tempfile.mkdtemp(prefix="alfred-merge-")
            print(f"copying db-capture.db out of volume {args.docker_volume}...")
            source = fetch_from_docker_volume(args.docker_volume, tmp)
        print(f"source {source}\ntarget {args.target}")
        merge(source, args.target, args.dry_run)
        return 0
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
