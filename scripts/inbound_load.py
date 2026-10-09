"""Inbound webhook load and burst generator (specs/013-inbound-calls-store, quickstart "Load and burst").

Posts each call's prepare and complete webhooks straight to a backend, with realistic bodies, and reports how many
were stored and how long each report took. Run it ONLY against a throwaway backend - thousands of fake calls in a real
store push the owner's real calls out through retention - which is why --url has no default.

    python scripts/inbound_load.py --url http://127.0.0.1:5099 --secret loadtest --calls 20000 --concurrency 8
    python scripts/inbound_load.py --url http://127.0.0.1:5099 --secret loadtest --calls 200 --concurrency 200
"""
import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone


def post(url, secret, body, timeout=60):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "X-Webhook-Secret": secret})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            r.read()
            return r.status, time.perf_counter() - started
    except urllib.error.HTTPError as e:
        return e.code, time.perf_counter() - started
    except Exception as e:  # refused, timeout
        return str(e), time.perf_counter() - started


def one_call(args, index, run):
    call_id = f"load-{run}-{index:06d}"
    path = f"/app/booking/{index % 50}/search?page={index % 7}"
    now = datetime.now(timezone.utc).isoformat()
    half = max(1, args.body_kb * 1024 // 2)
    prepare = {"id": call_id, "original_url": f"http://localhost:9001{path}", "url": f"http://wildfly:8080{path}",
               "method": "POST", "timestamp": now, "service_name": args.project,
               "request": {"headers": {"Content-Type": "application/json", "X-Request-Id": call_id},
                           "body": json.dumps({"query": "x" * (half // 4), "index": index})}}
    complete = {"response": {"status": 200 if index % 13 else 500, "headers": {"Content-Type": "application/json"},
                             "body": json.dumps({"results": ["r" * 64] * max(1, half // 70)})},
                "duration_ms": 10.0 + index % 300,
                "call": {k: prepare[k] for k in ("original_url", "url", "method", "timestamp", "service_name")}}
    p_status, p_time = post(f"{args.url}/internal-calls/webhook/prepare", args.secret, prepare)
    c_status, c_time = post(f"{args.url}/internal-calls/webhook/{call_id}/complete", args.secret, complete)
    return p_status, p_time, c_status, c_time


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="backend base URL of a THROWAWAY backend, e.g. http://127.0.0.1:5099")
    parser.add_argument("--secret", required=True, help="that backend's WEBHOOK_SECRET")
    parser.add_argument("--calls", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--body-kb", type=int, default=60, help="request + response body size per call")
    parser.add_argument("--project", default="loadtest")
    args = parser.parse_args()
    if args.url.rstrip("/").endswith((":3000", ":5000")):
        print("refusing: that looks like a real Alfred (port 3000/5000) - use a throwaway backend")
        return 2

    run = uuid.uuid4().hex[:6]
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = list(pool.map(lambda i: one_call(args, i, run), range(args.calls)))
    elapsed = time.perf_counter() - started

    times = sorted(t for r in results for t in (r[1], r[3]))
    failed = [r for r in results if r[0] != 200 or r[2] not in (204, 404)]
    with urllib.request.urlopen(f"{args.url}/internal-calls?requestId=load-{run}&limit=1", timeout=60) as r:
        stored = json.loads(r.read())["total"]
    p95 = times[int(len(times) * 0.95) - 1] if times else 0
    print(json.dumps({"calls": args.calls, "concurrency": args.concurrency, "bodyKb": args.body_kb,
                      "storedNow": stored, "failedCalls": len(failed), "seconds": round(elapsed, 1),
                      "reportP50ms": round(statistics.median(times) * 1000, 1) if times else None,
                      "reportP95ms": round(p95 * 1000, 1), "reportMaxMs": round(times[-1] * 1000, 1) if times else None}))
    if failed:
        print("first failures:", failed[:3])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
