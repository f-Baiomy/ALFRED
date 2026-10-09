"""Inbound E2E scenarios (specs/013-inbound-calls-store, research R9) against the isolated alfred-e2e Docker stack.

Run through tests/e2e/run_inbound_e2e.sh (builds the image, always tears the stack down). Each scenario prints
PASS/FAIL lines; the exit code is the number of failures. Scenarios: E1 stored complete · E2 stall · E3 restart ·
E4 outage · E5 forward proxy · E6 migration · E7 file/SQLite parity · E8 retention · E9 heap · E10 identity bounds.
Stdlib only, in the style of tests/e2e/native_install_e2e.py.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request as u
import uuid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(ROOT, "tests", "e2e", ".work")
BASE = "http://127.0.0.1:15000"
INBOUND = "http://127.0.0.1:18080"
FORWARD = "http://127.0.0.3:18443"
SECRET = "e2e"
COMPOSE = os.environ.get("E2E_COMPOSE",
                         "docker compose -p alfred-e2e --env-file tests/e2e/e2e.env -f docker-compose.yml "
                         "-f tests/e2e/compose.e2e.yml").split()
RUN = uuid.uuid4().hex[:6]
failures = 0


# ------------------------------------------------------------------ helpers (as in native_install_e2e.py)

def call(method, path, body=None, headers=None, base=BASE, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = u.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with u.urlopen(req, timeout=timeout) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text and text[0] in "[{" else text)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def wait(predicate, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def step(name, ok, detail=""):
    global failures
    if not ok:
        failures += 1
    print(("PASS " if ok else "FAIL ") + name + (" - " + str(detail)[:400] if detail else ""), flush=True)
    return ok


def compose(*args, env=None, check=True):
    return subprocess.run(COMPOSE + list(args), cwd=ROOT, env={**os.environ, **(env or {})}, check=check,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout


def proxy_log_since(seconds):
    return subprocess.run(["docker", "logs", "--since", f"{int(seconds)}s", "alfred-e2e-reverse-proxy"],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout


def fresh_stack(store="sqlite", retention=50, seed=None):
    """A clean stack: data folder emptied, optional seed(data_dir) run before start, then up and healthy."""
    compose("down", "-v", "--remove-orphans", check=False)
    shutil.rmtree(WORK, ignore_errors=True)
    for sub in ("data", "logs", "interception", "certs", "flags"):
        os.makedirs(os.path.join(WORK, sub), exist_ok=True)
    flags = {"reverse-proxy-enabled.flag": "e2e=on\n", "db-capture-enabled.flag": "", "log-link-enabled.flag": "",
             "redis-capture-enabled.flag": ""}
    for name, text in flags.items():
        with open(os.path.join(WORK, "flags", name), "w", newline="\n") as f:
            f.write(text)
    if seed:
        seed(os.path.join(WORK, "data"))
    env = {"INTERNAL_CALLS_STORAGE": store, "INTERNAL_CALLS_RETENTION_ROWS": str(retention)}
    compose("up", "-d", env=env)
    ok = wait(lambda: call("GET", "/health")[0] == 200, 180) and wait(lambda: send("/ping")[0] == 200, 60)
    if not ok:
        print(compose("logs", "--tail", "40", check=False))
    return ok


def send(path, method="GET", body=None, request_id=None, base=INBOUND, proxy=None, timeout=20):
    """One request through the reverse proxy (or the forward proxy). Returns (status, seconds, request id)."""
    rid = request_id or f"e2e-{RUN}-{uuid.uuid4().hex[:10]}"
    data = body.encode() if isinstance(body, str) else body
    req = u.Request(base + path if base else path, data=data, method=method,
                    headers={"X-Request-Id": rid, "Content-Type": "application/json"})
    opener = u.build_opener(u.ProxyHandler({"http": proxy})) if proxy else u.build_opener(u.ProxyHandler({}))
    started = time.time()
    try:
        with opener.open(req, timeout=timeout) as r:
            r.read()
            return r.status, time.time() - started, rid
    except urllib.error.HTTPError as e:
        return e.code, time.time() - started, rid
    except Exception as e:
        return str(e), time.time() - started, rid


def send_many(n, path, delay=0.0, threads=True):
    ids = [f"e2e-{RUN}-{uuid.uuid4().hex[:10]}" for _ in range(n)]
    results = {}
    if threads:
        workers = [threading.Thread(target=lambda rid=rid: results.__setitem__(rid, send(path, request_id=rid))) for rid in ids]
        for w in workers:
            w.start()
            time.sleep(delay)
        for w in workers:
            w.join(60)
    else:
        for rid in ids:
            results[rid] = send(path, request_id=rid)
            time.sleep(delay)
    return ids, results


def stored(call_id):
    """The stored call, with request and response, or None."""
    code, page = call("GET", f"/internal-calls?requestId={call_id}&limit=5")
    summary = next((c for c in (page.get("calls") or []) if c.get("id") == call_id), None) if code == 200 else None
    if not summary:
        return None
    code, detail = call("GET", f"/internal-calls/{call_id}/detail")
    return {**summary, **detail} if code == 200 else None


def complete(detail):
    return bool(detail and detail.get("method") and detail.get("url") and detail.get("timestamp")
                and detail.get("request") is not None and detail.get("response") is not None)


def all_stored_complete(ids, seconds=90):
    return wait(lambda: all(complete(stored(i)) for i in ids), seconds)


# ------------------------------------------------------------------ scenarios

def e1():
    status, _, rid = send("/hello?x=1", method="POST", body='{"greeting":"hi"}')
    ok = wait(lambda: complete(stored(rid)), 30)
    d = stored(rid) or {}
    step("E1 an inbound call is stored complete", status == 200 and ok and d.get("method") == "POST"
         and d.get("service_name") == "e2e" and "greeting" in (d.get("request") or {}).get("body", "")
         and '"method": "POST"' in (d.get("response") or {}).get("body", ""), d)


def e2():
    compose("pause", "backend")
    sent_at = time.time()
    ids, results = send_many(20, "/stall")
    answered = all(r[0] == 200 and r[1] < 5 for r in results.values())
    # The first report to time out may be any queued one (an earlier call's complete), not one of these prepares.
    seen = wait(lambda: re.search(r"\[webhook\] \S+ attempt 1/4 failed for \S+: timed out",
                                  proxy_log_since(time.time() - sent_at + 5)), 25)
    seen_after = time.time() - sent_at
    time.sleep(max(0, 20 - (time.time() - sent_at)))
    compose("unpause", "backend")
    ok = all_stored_complete(ids, 120)
    log = proxy_log_since(time.time() - sent_at + 5)
    step("E2 traffic never waits on a stalled backend", answered, {k: v[:2] for k, v in list(results.items())[:3]})
    step("E2 a failed attempt is visible while the backend is still stalled (SC-002)", seen and seen_after <= 25, f"{seen_after:.1f}s")
    step("E2 all 20 calls stored complete after a 20 s stall, none given up (SC-001)", ok and "given up" not in log)
    step("E2 report failure lines carry no body or secret", "greeting" not in log and "X-Webhook-Secret" not in log)


def e3():
    holder = {}
    sender = threading.Thread(target=lambda: holder.update(r=send_many(30, "/restart", delay=1.0, threads=False)))
    sender.start()
    time.sleep(3)
    compose("restart", "backend")
    sender.join(120)
    ids, _ = holder["r"]
    step("E3 all 30 calls survive a backend restart (SC-001)", all_stored_complete(ids, 150))


def e4():
    compose("stop", "backend")
    stopped_at = time.time()
    ids, results = send_many(3, "/outage")
    answered = all(r[0] == 200 and r[1] < 2 for r in results.values())
    gave_up = wait(lambda: proxy_log_since(time.time() - stopped_at + 5).count("given up for") >= 3, 120)
    compose("start", "backend")
    wait(lambda: call("GET", "/health")[0] == 200, 120)
    step("E4 traffic answered within 2 s while the backend is down (FR-002)", answered, results)
    step("E4 reports given up after their retries are logged (FR-003)", gave_up)


def e5():
    compose("pause", "backend")
    rid = f"e2e-{RUN}-fwd"
    status = send("http://e2e-upstream:8000/out-" + rid, base="", proxy=FORWARD, request_id=rid)[0]
    time.sleep(18)
    compose("unpause", "backend")
    found = wait(lambda: any(rid in (c.get("url") or "") for c in call("GET", f"/calls?search={rid}&limit=5")[1]["calls"]), 90)
    step("E5 an outbound call made during a stall is stored (forward proxy retries)", status == 200 and found)


def e8():
    ids, results = send_many(120, "/retention", delay=0.02, threads=False)
    # Reports are delivered by the proxy's worker in order: wait until the last call's have arrived.
    wait(lambda: complete(stored(ids[-1])), 120)
    code, page = call("GET", "/internal-calls?limit=200")
    kept = {c["id"] for c in page.get("calls", [])}
    newest = set(ids[-50:])
    step("E8 retention keeps exactly the newest 50 (FR-008)", page.get("total") == 50 and newest <= kept,
         f"total={page.get('total')} missing={len(newest - kept)}")
    times = []
    for i in range(20):
        rid = f"e2e-{RUN}-direct-{i}"
        t = time.time()
        call("POST", "/internal-calls/webhook/prepare", {"id": rid, "url": "http://e2e/x", "method": "GET",
                                                          "timestamp": "2026-10-09T00:00:00Z", "service_name": "e2e",
                                                          "request": {"headers": {}, "body": "x" * 60000}},
             headers={"X-Webhook-Secret": SECRET})
        call("POST", f"/internal-calls/webhook/{rid}/complete", {"response": {"status": 200, "headers": {}, "body": "y" * 60000},
                                                                "duration_ms": 1.0}, headers={"X-Webhook-Secret": SECRET})
        times.append(time.time() - t)
    step("E8 every report answered in under 1 s while retention trims (SC-005)", max(times) < 1.0, f"max={max(times):.3f}s")


def e9():
    limit = int(subprocess.run(["docker", "inspect", "alfred-e2e-backend", "--format", "{{.HostConfig.Memory}}"],
                               stdout=subprocess.PIPE, text=True).stdout.strip() or 0)
    flags = subprocess.run(["docker", "run", "--rm", "--pid=container:alfred-e2e-backend", "maven:3.9-eclipse-temurin-21",
                            "jcmd", "1", "VM.flags"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout
    m = re.search(r"MaxHeapSize=(\d+)", flags)
    heap = int(m.group(1)) if m else 0
    share = heap / limit if limit else 0
    step("E9 backend heap is 75 % of its container limit (FR-004)", 0.74 <= share <= 0.76, f"heap={heap} limit={limit} share={share:.3f}")


def e10():
    rid = f"e2e-{RUN}-bounds"
    code, _ = call("POST", f"/internal-calls/webhook/{rid}/complete",
                   {"response": {"status": 200, "headers": {}, "body": ""}, "duration_ms": 1.0,
                    "call": {"url": "http://e2e/" + "a" * 9000, "method": "GET", "timestamp": "2026-10-09T00:00:00Z",
                             "service_name": "e2e"}}, headers={"X-Webhook-Secret": SECRET})
    step("E10 an oversized call identity is refused with 400 (FR-015)", code == 400, code)


def legacy_line(i, body_kb=20):
    return {"id": f"legacy-{i:03d}", "original_url": f"http://localhost:18080/legacy/{i}", "url": f"http://e2e-upstream:8000/legacy/{i}",
            "method": "POST", "request": {"headers": {"Content-Type": "application/json"}, "body": "r" * 5000},
            "timestamp": f"2026-10-08T10:{i // 60:02d}:{i % 60:02d}.000+00:00", "duration_ms": 12.5,
            "response": {"status": 200, "headers": {"Content-Type": "application/json"}, "body": "s" * (body_kb * 1024)},
            "error": None, "state": "COMPLETED", "session_id": None, "operation_id": None, "service_name": "e2e"}


def e6():
    deleted = "legacy-078"

    def seed(data):
        with open(os.path.join(data, "internal-calls.log"), "w", newline="\n") as f:
            for i in range(80):
                line = legacy_line(i)
                if i == 40:
                    f.write("{not json\n")
                    continue
                if i == 41:
                    line.pop("id")
                f.write(json.dumps(line) + "\n")
        with open(os.path.join(data, "internal-calls.log.relive-deleted"), "w", newline="\n") as f:
            f.write(deleted + "\n")

    if not step("E6 stack with a legacy inbound file starts", fresh_stack(seed=seed)):
        return
    code, page = call("GET", "/internal-calls?sort=oldest&limit=200")
    ids = [c["id"] for c in page.get("calls", [])]
    # The file store served its newest 50 lines (30..79); of those, line 40 is malformed and legacy-078 was deleted
    # with its Relive run. Line 41 had no id and is moved with a new one.
    expected_legacy = [f"legacy-{i:03d}" for i in range(30, 80) if i not in (40, 41) and f"legacy-{i:03d}" != deleted]
    legacy = [i for i in ids if i.startswith("legacy-")]
    files = os.listdir(os.path.join(WORK, "data"))
    step("E6 exactly the calls the file store was serving are moved, in order (FR-009)",
         legacy == expected_legacy and len(ids) == len(expected_legacy) + 1, f"got {len(ids)}, first={ids[:2]}")
    step("E6 old file kept as .migrated and the database exists", "internal-calls.log.migrated" in files and "internal-calls.db" in files, files)
    compose("restart", "backend")
    wait(lambda: call("GET", "/health")[0] == 200, 120)
    code, again = call("GET", "/internal-calls?sort=oldest&limit=200")
    again_ids = [c["id"] for c in again.get("calls", [])]
    # Compared on the moved calls only - the stack's own /ping call may arrive in between.
    step("E6 a restart changes nothing (no duplicates)",
         [i for i in again_ids if not i.startswith("e2e-")] == [i for i in ids if not i.startswith("e2e-")]
         and len(again_ids) == len(set(again_ids)), again_ids[:3])


def parity_snapshot(ids, cycle_id):
    """Every store answer E7 compares, with times and durations taken out."""
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in sorted(value.items())
                    if k not in ("timestamp", "durationMs", "duration_ms", "timing", "capturedAt", "id", "Date", "date")
                    or (k == "id" and isinstance(v, str) and v.startswith("e2e-par-"))}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value

    snap = {}
    ours = lambda rows: [c["id"] for c in rows if c["id"].startswith("e2e-par-")]  # not the stack's own /ping call
    for sort in ("newest", "oldest"):
        snap["list-" + sort] = ours(call("GET", f"/internal-calls?sort={sort}&limit=200")[1]["calls"])
    # Durations are real timings that differ between two runs, so "slowest" is checked within each store instead.
    slowest = [c for c in call("GET", "/internal-calls?sort=slowest&limit=200")[1]["calls"] if c["id"].startswith("e2e-par-")]
    durations = [c.get("duration_ms") or -1 for c in slowest]
    snap["slowest-ordered"] = durations == sorted(durations, reverse=True) and len(slowest) == len(ids)
    snap["search-body"] = sorted(ours(call("GET", "/internal-calls?search=needle-in-body&limit=200")[1]["calls"]))
    snap["project"] = sorted(ours(call("GET", "/internal-calls?serviceNames=e2e&limit=200")[1]["calls"]))
    snap["status-404"] = sorted(ours(call("GET", "/internal-calls?search=404&limit=200")[1]["calls"]))
    snap["details"] = {i: clean(call("GET", f"/internal-calls/{i}/detail")[1]) for i in ids[:3] + ids[-1:]}
    snap["overlaps"] = clean(call("GET", "/call-overlaps?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z")[1])
    cyc = call("GET", f"/session-cycles/{cycle_id}/internal-calls?limit=200")[1]
    snap["cycle"] = sorted(clean(c.get("call", c)).get("id", "") for c in (cyc.get("calls", []) if isinstance(cyc, dict) else cyc))
    return snap


def run_parity_calls():
    code, cycle = call("POST", "/session-cycles", {"name": "e2e parity"})
    call("POST", f"/session-cycles/{cycle['id']}/record")
    ids = []
    for i in range(30):
        rid = f"e2e-par-{i:02d}"
        path = ["/a", "/b?status=404", "/c?ms=50", "/d?kb=2048" if i == 7 else "/d"][i % 4]
        method = ["GET", "POST", "PUT", "DELETE"][i % 4]
        body = '{"note":"needle-in-body"}' if i % 5 == 0 else '{"note":"plain"}'
        send(path, method=method, body=body if method != "GET" else None, request_id=rid)
        ids.append(rid)
    all_stored_complete(ids, 120)
    call("POST", f"/session-cycles/{cycle['id']}/pause")
    return ids, cycle["id"]


def e7():
    answers = {}
    for store in ("file", "sqlite"):
        if not step(f"E7 {store} stack starts", fresh_stack(store=store, retention=100)):
            return
        ids, cycle_id = run_parity_calls()
        answers[store] = parity_snapshot(ids, cycle_id)
    diffs = [k for k in answers["file"] if answers["file"][k] != answers["sqlite"].get(k)]
    detail = {k: (json.dumps(answers["file"][k])[:600], json.dumps(answers["sqlite"].get(k))[:600]) for k in diffs[:2]}
    step("E7 file and SQLite stores give the same answers (FR-010, FR-013)", not diffs, {"keys": diffs, "first": detail})


SCENARIOS = {"E1": e1, "E2": e2, "E3": e3, "E4": e4, "E5": e5, "E10": e10, "E9": e9, "E8": e8, "E6": e6, "E7": e7}
SHARED = ["E1", "E2", "E3", "E4", "E5", "E10", "E9", "E8"]  # one stack, in this order (E8 floods it last)


def main(names):
    chosen = [n.upper() for n in names] or list(SCENARIOS)
    unknown = [n for n in chosen if n not in SCENARIOS]
    if unknown:
        print("unknown scenarios:", unknown)
        return 2
    shared = [n for n in SHARED if n in chosen]
    if shared and step("shared stack starts", fresh_stack()):
        for name in shared:
            SCENARIOS[name]()
    for name in ("E6", "E7"):
        if name in chosen:
            SCENARIOS[name]()
    compose("down", "-v", "--remove-orphans", check=False)
    print(f"{failures} failure(s)", flush=True)
    return failures


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
