"""End-to-end check of a native install inside a clean container (specs/012-server-program quickstart US1/US3/US4).
Run with the bundled Python after the installer: python3 e2e-linux.py"""
import json
import subprocess
import sys
import time
import urllib.request as u

BASE = "http://127.0.0.1:3000"


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = u.Request(BASE + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with u.urlopen(req, timeout=30) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text and text[0] in "[{" else text)
    except u.HTTPError as e:
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
    print(("PASS " if ok else "FAIL ") + name + (" - " + str(detail)[:300] if detail else ""), flush=True)
    return ok


results = []
app = subprocess.Popen([sys.executable, "-m", "http.server", "8080", "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

# Outbound: a call through the forward proxy is logged.
proxy = u.build_opener(u.ProxyHandler({"http": "http://127.0.0.2:443"}))
status = proxy.open("http://127.0.0.1:8080/", timeout=20).status
logged = wait(lambda: call("GET", "/calls?limit=5")[1]["calls"][0]["url"].startswith("http://127.0.0.1:8080"), 20)
results.append(step("outbound call through 127.0.0.2:443 is logged", status == 200 and logged, call("GET", "/calls?limit=1")[1]))

# Settings: save a project + inbound logging; the supervisor starts the reverse proxy.
code, settings = call("GET", "/server/settings")
results.append(step("GET /server/settings", code == 200 and settings["mode"] == "NATIVE", len(settings.get("settings", []))))
code, preview = call("POST", "/server/settings/preview", {"baseHash": settings["envHash"], "edits": [
    {"key": "REVERSE_PROXY_ENABLED", "value": "true"}, {"key": "INTERNAL_CALL_SERVICES", "value": "demo:9001:8080"},
    {"key": "INTERNAL_CALLS_RETENTION_ROWS", "value": "3000"}, {"key": "ALFRED_MEMORY", "value": "1g"}]})
results.append(step("preview shows the .env lines", code == 200 and any(d["after"] == "INTERNAL_CALL_SERVICES=demo:9001:8080" for d in preview["diff"]), preview))
started = time.time()
code, saved = call("PUT", "/server/settings", {"baseHash": settings["envHash"], "edits": [
    {"key": "REVERSE_PROXY_ENABLED", "value": "true"}, {"key": "INTERNAL_CALL_SERVICES", "value": "demo:9001:8080"},
    {"key": "INTERNAL_CALLS_RETENTION_ROWS", "value": "3000"}, {"key": "ALFRED_MEMORY", "value": "1g"}]})
outcomes = {a["key"]: a["outcome"] for a in saved.get("applied", [])} if code == 200 else saved
if code == 200:
    print("TIME save_request_s %.2f" % (time.time() - started))
    for a in saved["applied"]:
        print("TIME applied %s %s %d ms" % (a["key"], a["outcome"], a.get("tookMs", 0)))
results.append(step("save applies live / restarts proxies / waits for restart", code == 200
                    and outcomes.get("INTERNAL_CALLS_RETENTION_ROWS") == "APPLIED"
                    and outcomes.get("INTERNAL_CALL_SERVICES") == "PROXIES_RESTARTED"
                    and outcomes.get("ALFRED_MEMORY") == "PENDING_RESTART", outcomes))
env = open("/opt/alfred/.env").read()
results.append(step(".env written, comments kept", "INTERNAL_CALL_SERVICES=demo:9001:8080" in env and env.startswith("# Alfred settings"), ""))
reverse_up = wait(lambda: any(p["name"] == "REVERSE" and p["state"] == "RUNNING" for p in call("GET", "/server/status")[1]["processes"]), 30)
results.append(step("reverse proxy started by the save", reverse_up, call("GET", "/server/status")[1]["processes"]))

# Inbound: a call through the project's listen port is logged.
call("POST", "/internal-calls/services/demo/logging-enabled", {"enabled": True})
inbound_status = wait(lambda: u.urlopen("http://127.0.0.1:9001/", timeout=10).status == 200, 20)
inbound_logged = wait(lambda: len(call("GET", "/internal-calls?limit=5")[1]["calls"]) > 0, 20)
results.append(step("inbound call through localhost:9001 is logged", inbound_status and inbound_logged, call("GET", "/internal-calls?limit=1")[1]))

# A bad value is refused, nothing written.
code, refused = call("PUT", "/server/settings", {"baseHash": call("GET", "/server/settings")[1]["envHash"],
                                                  "edits": [{"key": "ALFRED_UI_PORT", "value": "70000"}]})
results.append(step("invalid value refused with 422", code == 422, refused))
# Tunnel headers make every write read-only.
code, _ = call("PUT", "/server/settings", {"edits": [{"key": "ALFRED_MEMORY", "value": "2g"}]}, {"Cf-Ray": "abc"})
results.append(step("write through the tunnel refused with 403", code == 403, code))

# Restart the backend from the API: proxies keep running; the backend comes back with the new memory.
outbound_pid = [p["pid"] for p in call("GET", "/server/status")[1]["processes"] if p["name"] == "OUTBOUND"][0]
restart_started = time.time()
code, _ = call("POST", "/server/restart", {"what": "BACKEND"})
time.sleep(3)
back = wait(lambda: call("GET", "/health")[0] == 200, 90)
print("TIME backend_restart_to_health_s %.1f" % (time.time() - restart_started))
status = call("GET", "/server/status")[1] if back else {}
same_proxy = back and [p["pid"] for p in status["processes"] if p["name"] == "OUTBOUND"][0] == outbound_pid
heap_ok = back and status["heapMaxBytes"] <= 1100 * 1024 * 1024
pending = call("GET", "/server/settings")[1]["pendingRestart"] if back else None
results.append(step("restart: backend back, proxies untouched, 1g heap, pending cleared", code == 202 and back and same_proxy and heap_ok and pending == [],
                    {"code": code, "back": back, "same_proxy": same_proxy, "heapMax": status.get("heapMaxBytes"), "pending": pending}))

code, history = call("GET", "/server/settings/history")
results.append(step("history has the install baseline and the save", code == 200 and [h["source"] for h in history][-1] == "INSTALL" and any(h["source"] == "UI" for h in history), [h["source"] for h in history] if code == 200 else history))

app.terminate()
print("SUMMARY", sum(results), "of", len(results), "passed")
sys.exit(0 if all(results) else 1)
