#!/usr/bin/env python3
"""Generates a JSON-per-line log file for the Logs Explorer (specs/004-logs-explorer, task T094).

Each line is an OpenSearch-style hit (like the one in the spec) with three grouping levels -
sessionId -> inboundCallId -> externalCallId - plus the edge cases the grouped view must handle:
a session without its level-1 line, a skipped level, lines without any id, and a line that is not
valid JSON. Deterministic for a given --seed.

    python scripts/gen-logs.py --size 10G --out logs-drop/opensearch-export.ndjson
    python scripts/gen-logs.py --lines 5000 --out logs-drop/sample.ndjson
"""
import argparse
import json
import random
import sys
from datetime import datetime, timedelta, timezone

SUPPLIERS = ["TravelportNdc", "FlyAdealUAE", "Sabre", "Amadeus", "AirArabia"]
ROUTES = ["DXB-CAI", "AUH-LHR", "DXB-JED", "SHJ-KHI", "DXB-IST"]
VMS = ["portal-24", "portal-25"]


def parse_size(text):
    units = {"K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}
    return int(float(text[:-1]) * units[text[-1].upper()]) if text[-1].upper() in units else int(text)


def hit(ts, level, method, message, ids, ctx, vm):
    msg = {"methodName": method, "message": message, **{k: v for k, v in ids.items() if v}}
    if ctx:
        msg["context"] = ctx
    iso = ts.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    attributes = {
        "log.level": level, "log.logger": "DetailLogger", "message": msg,
        "process.thread.name": f"pool-6869-thread-{random.randint(1, 40)}", "timestamp": iso,
    }
    body = {"timestamp": iso, "log.level": level, "message": msg, "log.logger": "DetailLogger"}
    return {
        "_index": "logs", "_id": "%016x" % random.getrandbits(64),
        "_source": {
            "attributes": attributes, "body": json.dumps(body, separators=(",", ":")),
            "resource": {"service.name": f"ndc-prd-ne-{vm}-z2"}, "@timestamp": iso,
        },
        "fields": {"VM_name": [vm], "ERROR_flag": [1 if level == "ERROR" else 0], "date_with_weekday": [iso[:10] + " (THURSDAY)"]},
    }


def session(t, n, out):
    vm = random.choice(VMS)
    sid = f"S-{9100 + n}"
    user = f"AGN{random.randint(1400, 1499)}"
    out.append(hit(t, "INFO", "loginV2", "session start", {"sessionId": sid},
                   {"request": f"LoginDTO(email=agent{random.randint(10, 99)}@travel.ae, password=null, displayUserType={user})"}, vm))
    for _ in range(random.randint(1, 3)):
        t += timedelta(seconds=random.randint(2, 40))
        ic = f"IC-{random.randint(10 ** 6, 10 ** 7)}"
        route = random.choice(ROUTES)
        start = t
        out.append(hit(t, "INFO", "searchFlights", f"inbound request POST /search {route}", {"sessionId": sid, "inboundCallId": ic}, {"route": route}, vm))
        end = t
        for _ in range(random.randint(1, 3)):
            ex = f"EX-{random.randint(10 ** 6, 10 ** 7)}"
            sup = random.choice(SUPPLIERS)
            st = t + timedelta(milliseconds=random.randint(20, 300))
            ids = {"sessionId": sid, "inboundCallId": ic, "externalCallId": ex}
            out.append(hit(st, "INFO", "performOperation", "Start external system call", ids, {"externalService": sup, "actionName": "Search"}, vm))
            r = random.random()
            level, code, took, err = "INFO", 200, random.randint(900, 7200), None
            if r < 0.1:
                level, code, took, err = "ERROR", 504, 30000, "java.net.SocketTimeoutException: Read timed out"
            elif r < 0.18:
                level, code, took, err = "WARN", 429, random.randint(300, 1500), "Rate limited by supplier, retry scheduled"
            ctx = {"externalService": sup, "actionName": "Search", "statusCode": code, "timeTaken": took}
            if err:
                ctx["error"] = err
            fin = st + timedelta(milliseconds=took)
            out.append(hit(fin, level, "performOperation", "End external system call" if level == "INFO" else "Supplier problem", ids, ctx, vm))
            end = max(end, fin)
        if random.random() < 0.2:  # skipped level: session + external call, no inbound call
            out.append(hit(t, "INFO", "cacheLookup", "fare cache miss", {"sessionId": sid, "externalCallId": f"EX-{random.randint(10 ** 6, 10 ** 7)}"}, {"cacheKey": route}, vm))
        t = end + timedelta(milliseconds=random.randint(50, 400))
        out.append(hit(t, "INFO", "searchFlights", f"inbound response {route}", {"sessionId": sid, "inboundCallId": ic},
                       {"statusCode": 200, "timeTaken": int((t - start).total_seconds() * 1000)}, vm))
    if random.random() < 0.3:
        out.append(hit(t + timedelta(seconds=5), "INFO", "scheduler", "scheduler tick refresh currency rates", {}, {"jobId": f"cur-{random.randint(1, 9)}"}, vm))
    return t


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--size", help="stop after this many bytes, e.g. 10G")
    p.add_argument("--lines", type=int, help="stop after about this many lines")
    p.add_argument("--seed", type=int, default=11)
    a = p.parse_args()
    if not a.size and not a.lines:
        sys.exit("give --size or --lines")
    random.seed(a.seed)
    limit_bytes = parse_size(a.size) if a.size else None
    written = lines = n = 0
    t = datetime(2026, 10, 1, 18, 0, tzinfo=timezone.utc)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        orphan = [hit(t, "WARN", "searchFlights", "inbound request session not found", {"sessionId": "S-0999", "inboundCallId": "IC-1"}, {}, "portal-25")]
        for h in orphan:
            s = json.dumps(h, separators=(",", ":")) + "\n"
            f.write(s)
            written += len(s.encode())
            lines += 1
        f.write('{"timestamp":"2026-10-01T18:00:01Z","log.level":"INFO"\n')
        while (limit_bytes is None or written < limit_bytes) and (a.lines is None or lines < a.lines):
            batch = []
            t = session(t + timedelta(seconds=random.randint(1, 30)), n, batch)
            n += 1
            for h in batch:
                s = json.dumps(h, separators=(",", ":")) + "\n"
                f.write(s)
                written += len(s.encode())
                lines += 1
    print(f"wrote {lines} lines, {written / 1024 ** 2:.1f} MB to {a.out}")


if __name__ == "__main__":
    main()
