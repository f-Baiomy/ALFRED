"""
panel.py - `alfred` in a terminal: a live control panel. Standard library only.

What it shows: the supervisor's processes, the Java apps and their agent, storage per store, traffic in the last minute
(inbound and outbound), the calls that need attention, the latest calls, and one-key actions.

No polling: the panel listens on the backend's WebSockets (/ws/calls, /ws/internal-calls, /ws/server, /ws/triage - the
same "something changed" signals the web UI uses) and re-reads only when one says something changed. The screen is
redrawn once a second for the clock and the "last 60 s" window, from what it already has - nothing is fetched on that
timer. A socket that drops is reconnected with a back-off.

Actions that print (start, stop, restart, logs, update, doctor, attach) leave the panel's screen, run the ordinary
command - with its own live steps - and come back on a key. Anything that stops Alfred asks first.
"""

import base64
import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import term as termlib

WINDOWS = os.name == "nt"
SPARK = "▁▂▃▄▅▆▇█"
CHANNELS = ("/ws/calls", "/ws/internal-calls", "/ws/server", "/ws/triage")


# ---------------------------------------------------------------------------------------------------------------------
# the change signal: a minimal WebSocket client (RFC 6455, text frames only, client masking, no extensions)
# ---------------------------------------------------------------------------------------------------------------------

class Signals:
    """Sets `changed` whenever any channel sends a frame. One thread per channel, reconnecting with a back-off."""

    def __init__(self, port, channels=CHANNELS):
        self.port, self.channels = port, channels
        self.changed = threading.Event()
        self.stop = threading.Event()
        self.connected = set()

    def start(self):
        for channel in self.channels:
            threading.Thread(target=self._listen, args=(channel,), name=f"panel{channel}", daemon=True).start()

    def _listen(self, channel):
        delay = 1
        while not self.stop.is_set():
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=10) as sock:
                    handshake(sock, "127.0.0.1", self.port, channel)
                    self.connected.add(channel)
                    self.changed.set()  # (re)connected: what was missed meanwhile is read once
                    delay = 1
                    sock.settimeout(60)
                    while not self.stop.is_set():
                        try:
                            if read_frame(sock) is None:
                                break
                        except socket.timeout:
                            send_frame(sock, 0x9, b"")  # ping: a quiet socket is kept, a dead one shows up
                            continue
                        self.changed.set()
            except (OSError, ValueError):
                pass
            self.connected.discard(channel)
            if self.stop.wait(delay):
                return
            delay = min(delay * 2, 15)


def handshake(sock, host, port, path):
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://{host}:{port}\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1024)
        if not chunk:
            raise ValueError("closed during the handshake")
        head += chunk
        if len(head) > 16384:
            raise ValueError("handshake too long")
    if b" 101 " not in head.split(b"\r\n", 1)[0]:
        raise ValueError(head.split(b"\r\n", 1)[0].decode(errors="replace"))


def _recv(sock, n):
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ValueError("closed")
        data += chunk
    return data


def read_frame(sock):
    """The next data frame's payload; None on a close frame. Pings are answered, pongs skipped."""
    while True:
        first, second = _recv(sock, 2)
        opcode, length = first & 0x0F, second & 0x7F
        if length == 126:
            length = struct.unpack(">H", _recv(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", _recv(sock, 8))[0]
        mask = _recv(sock, 4) if second & 0x80 else None
        payload = _recv(sock, length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x8:
            return None
        if opcode == 0x9:
            send_frame(sock, 0xA, payload)
            continue
        if opcode == 0xA:
            continue
        return payload


def send_frame(sock, opcode, payload):
    mask = os.urandom(4)
    header = bytes([0x80 | opcode])
    n = len(payload)
    header += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
    sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


# ---------------------------------------------------------------------------------------------------------------------
# keys
# ---------------------------------------------------------------------------------------------------------------------

class Keys:
    """One key at a time without Enter: msvcrt on Windows, cbreak mode on a POSIX terminal (restored on exit)."""

    def __enter__(self):
        if not WINDOWS:
            import termios
            import tty
            self.fd = sys.stdin.fileno()
            self.saved = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)
        return self

    def __exit__(self, *exc):
        if not WINDOWS:
            import termios
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self.saved)
        return False

    def read(self, timeout):
        """A key ('q', 'esc', 'enter', ...) or None after `timeout` seconds."""
        if WINDOWS:
            import msvcrt
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if msvcrt.kbhit():
                    ch = msvcrt.getwch()
                    if ch in ("\x00", "\xe0"):
                        msvcrt.getwch()
                        return None
                    return {"\x1b": "esc", "\r": "enter", "\x03": "q"}.get(ch, ch.lower())
                time.sleep(0.03)
            return None
        import select
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        if not ready:
            return None
        ch = os.read(self.fd, 1).decode(errors="ignore")
        if ch == "\x1b":
            more, _, _ = select.select([sys.stdin], [], [], 0.02)
            if more:
                os.read(self.fd, 8)  # an arrow key's sequence: ignored
                return None
            return "esc"
        return {"\n": "enter", "\r": "enter"}.get(ch, ch.lower())


# ---------------------------------------------------------------------------------------------------------------------
# data
# ---------------------------------------------------------------------------------------------------------------------

def parse_time(text):
    try:
        value = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def per_bucket(calls, now, seconds=60, buckets=24):
    """How many calls arrived in each of `buckets` slices of the last `seconds`, oldest first."""
    counts = [0] * buckets
    width = seconds / buckets
    for call in calls:
        at = parse_time(call.get("timestamp"))
        if at is None:
            continue
        age = (now - at).total_seconds()
        if 0 <= age < seconds:
            counts[buckets - 1 - int(age // width)] += 1
    return counts


def sparkline(counts):
    top = max(counts) if counts and max(counts) else 0
    return "".join(SPARK[0] if not top else SPARK[min(7, round(c / top * 7))] for c in counts)


class Snapshot:
    """What the panel shows, read on a change signal (or an action). Each part keeps its last good value."""

    def __init__(self, layout, alfred):
        self.layout, self.alfred = layout, alfred
        self.status = None
        self.update = {}
        self.stats = {}
        self.attention = {}
        self.inbound, self.outbound = [], []
        self.lock = threading.Lock()
        self.read_at = None

    def get(self, path, timeout=5):
        with urllib.request.urlopen(self.layout.local_url() + path, timeout=timeout) as response:
            return json.load(response)

    def refresh(self):
        status = self.alfred.call_supervisor(self.layout, "GET", "/status", timeout=3)
        parts = {"status": status}
        if status:
            since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
            for name, path in (("update", "/server/update"), ("stats", "/database/stats"),
                               ("attention", "/triage/counts?since=" + urllib.request.quote(since)),
                               ("inbound", "/internal-calls?limit=200"), ("outbound", "/calls?limit=200")):
                try:
                    parts[name] = self.get(path)
                except (urllib.error.URLError, OSError, ValueError):
                    pass
        with self.lock:
            self.status = parts["status"]
            for name in ("update", "stats", "attention"):
                if name in parts:
                    setattr(self, name, parts[name] or {})
            for name in ("inbound", "outbound"):
                if name in parts:
                    setattr(self, name, (parts[name] or {}).get("calls", []))
            self.read_at = time.monotonic()


# ---------------------------------------------------------------------------------------------------------------------
# drawing
# ---------------------------------------------------------------------------------------------------------------------

KEYS = [("q", "quit"), ("s", "stop/start"), ("r", "restart"), ("p", "proxies"), ("l", "logs"), ("t", "triage"),
        ("a", "attach"), ("u", "update"), ("d", "doctor"), ("o", "open UI")]


def key_lines(t, width):
    """The key line, wrapped to the window - every key stays visible, quit first."""
    lines, current = [], ""
    for k, what in KEYS:
        piece = t.c(k, "teal", "bold") + " " + t.c(what, "dim")
        if current and termlib.visible_len(current) + 3 + termlib.visible_len(piece) > width - 4:
            lines.append("  " + current)
            current = piece
        else:
            current = current + "   " + piece if current else piece
    return lines + (["  " + current] if current else [])


def render(t, snap, width, height, alfred, note=""):
    """The panel's lines for a window of width x height (two columns from 100 columns, stacked below that)."""
    layout = snap.layout
    dot = t.g["dot"]
    now = datetime.now(timezone.utc)
    with snap.lock:
        status, update, stats, attention = snap.status, snap.update, snap.stats, snap.attention
        inbound, outbound = list(snap.inbound), list(snap.outbound)
    processes = (status or {}).get("processes", [])
    running = bool(status) and all(p["state"] == "RUNNING" for p in processes)
    oldest = min((p["startedAt"] for p in processes if p.get("pid") and p.get("startedAt")), default=None)
    version = (status or {}).get("version") or layout.version()

    head = "  " + t.brand(f"Alfred {version}") + "  "
    if not status:
        head += t.state("STOPPED")
    elif running:
        head += t.state("RUNNING") + t.c(f" {alfred.uptime(oldest)}", "dim")
    else:
        head += t.c(t.g["part"] + " starting/restarting", "yellow")
    head += "   " + t.url(f"http://localhost:{layout.ui_port()}")
    job = (update or {}).get("job") or {}
    if job.get("state") in ("DOWNLOADING", "VERIFYING", "INSTALLING"):
        head += "   " + t.c(f"{t.g['up']} updating to {job.get('version')}", "yellow")
    elif job.get("state") == "PAUSED":
        head += "   " + t.c(f"{t.g['pause']} update paused", "yellow")
    elif (update or {}).get("available"):
        head += "   " + t.c(f"{t.g['up']} {update.get('latestVersion')}", "yellow") + t.c("  u update", "dim")
    clock = datetime.now().strftime("%H:%M:%S")
    lines = [termlib.pad(head, width - len(clock) - 2) + t.c(clock, "dim"), "  " + t.c(t.g["bar_empty"] * (width - 4), "dim")]

    left = [t.c("PROCESSES", "dim", "bold")]
    if not status:
        left += [t.c("Alfred is stopped - s starts it", "dim")]
    for p in processes:
        listen = (p.get("listeners") or [""])[0].replace(" -> ", f" {t.g['arrow']} ")
        up = alfred.uptime(p.get("startedAt")) if p.get("pid") else "-"
        restarts = t.c(f"  {t.g['retry']}{p['restarts']}", "yellow") if p.get("restarts") else ""
        mark, word = t.state(p["state"]).split(" ", 1)
        left.append(f"{mark} {p['name'].lower():<9} " + termlib.pad(word, 11)
                    + t.c(f"{up:<12}{listen}", "dim") + restarts)
    agents = (status or {}).get("agents") or []
    if agents:
        left += ["", t.c("JAVA APPS", "dim", "bold")]
        for a in agents:
            if a.get("state") == "ATTACHED":
                left.append(t.c(t.g["run"], "green") + f" {a.get('project', '?'):<9}" + t.c(f"pid {a.get('pid')} {dot} ", "dim") + t.c(a.get("features") or "loaded", "teal"))
            else:
                left.append(t.c(t.g["wait"], "dim") + f" {a.get('project', '?'):<9}" + t.c(f"{a.get('state', '').lower().replace('_', ' ')} {dot} ", "dim") + t.cmd("a") + t.c(" attach", "dim"))
    files = sorted((stats or {}).get("files", []), key=lambda f: f.get("sizeBytes", 0), reverse=True)
    if files:
        left += ["", t.c("STORAGE", "dim", "bold")]
        biggest = max(f.get("sizeBytes", 0) for f in files) or 1
        for f in files[:4]:
            left.append(f"{f['name'][:17]:<18}" + t.bar(f.get("sizeBytes", 0) / biggest, 10) + t.c(f"  {alfred.size_text(f.get('sizeBytes', 0))} {dot} {f.get('rows', 0):,} rows", "dim"))

    right = [t.c("TRAFFIC", "dim", "bold") + t.c("  last 60 s", "dim")]
    for label, calls, color in (("inbound", inbound, "teal"), ("outbound", outbound, "blue")):
        counts = per_bucket(calls, now)
        right.append(f"{label:<10}" + t.c(sparkline(counts), color) + t.c(f"  {sum(counts)}/min", "white"))
    worst = sum(n for level, n in (attention or {}).items() if str(level).isdigit() and int(level) <= 3)
    right.append(f"{'attention':<10}" + (t.c(f"{t.g['warn']} {worst} calls in the last hour", "red") if worst else t.c("nothing in the last hour", "dim"))
                 + t.c(f" {dot} ", "dim") + t.cmd("t") + t.c(" triage", "dim"))
    right += ["", t.c("LATEST CALLS", "dim", "bold")]
    latest = sorted([("IN ", c) for c in inbound[:20]] + [("OUT", c) for c in outbound[:20]],
                    key=lambda item: parse_time(item[1].get("timestamp")) or now - timedelta(days=9999), reverse=True)
    room = max(4, height - 6 - (0 if width >= 100 else len(left) + 1))
    for direction, c in latest[:min(room, 12)]:
        at = parse_time(c.get("timestamp"))
        code = c.get("status")
        code_text = t.c(str(code), "red", "bold") if code and code >= 500 else t.c(str(code), "yellow") if code and code >= 400 else t.c(str(code or "…"), "green")
        ms = c.get("duration_ms")
        took = (f"{ms / 1000:.1f} s" if ms and ms >= 1000 else f"{ms:.0f} ms") if ms is not None else ""
        path = c.get("url") or c.get("original_url") or ""
        path = path.split("://", 1)[-1] if direction == "OUT" else "/" + path.split("://", 1)[-1].split("/", 1)[-1] if "://" in path else path
        right.append(t.c(at.astimezone().strftime("%H:%M:%S") if at else "--:--:--", "dim") + " " + t.c(direction, "teal" if direction == "IN " else "blue")
                     + " " + t.c(f"{(c.get('method') or '')[:6]:<6}", "white") + f" {path[:30]:<30} " + code_text + t.c(f" {took:>7}", "dim"))
    if not latest:
        right.append(t.c("no calls yet", "dim"))

    if width >= 100:
        col = 50
        for i in range(max(len(left), len(right))):
            lines.append("  " + termlib.pad(left[i] if i < len(left) else "", col) + (right[i] if i < len(right) else ""))
    else:
        lines += ["  " + line for line in left] + [""] + ["  " + line for line in right]
    lines.append("  " + t.c(t.g["bar_empty"] * (width - 4), "dim"))
    if note:
        lines.append("  " + note)
    else:
        lines += key_lines(t, width)
    return lines


# ---------------------------------------------------------------------------------------------------------------------
# the loop
# ---------------------------------------------------------------------------------------------------------------------

class Screen:
    """The alternate screen: entered on start, left (cursor back) on exit or when an action prints."""

    def __init__(self, stream):
        self.stream = stream

    def enter(self):
        self.stream.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J")
        self.stream.flush()

    def leave(self):
        self.stream.write("\x1b[?25h\x1b[?1049l")
        self.stream.flush()

    def draw(self, lines, width, height, footer=2):
        if len(lines) > height - 1:
            # Never taller than the window (a taller frame scrolls and leaves stale lines above): the header and the
            # `footer` lines (the rule and the keys) stay, the body is cut from the bottom - the oldest calls go first.
            lines = lines[:max(1, height - 1 - footer)] + lines[-footer:]
        out = ["\x1b[H"]
        for line in lines:
            shown = line if termlib.visible_len(line) < width else termlib._clip(line, width - 1)
            out.append(shown + "\x1b[K\n")
        out.append("\x1b[J")
        self.stream.write("".join(out))
        self.stream.flush()


def run(layout, alfred):
    """The panel until q / Esc. Returns an exit code."""
    t = termlib.Term()
    if not t.live:
        return None  # not a terminal: the caller prints the help instead
    snap = Snapshot(layout, alfred)
    signals = Signals(layout.ui_port())
    signals.start()
    screen = Screen(t.stream)
    reader = threading.Thread(target=snap.refresh, daemon=True)
    reader.start()
    note = ""
    try:
        with Keys() as keys:
            screen.enter()
            while True:
                if signals.changed.is_set() and not reader.is_alive():
                    signals.changed.clear()
                    reader = threading.Thread(target=snap.refresh, daemon=True)
                    reader.start()
                size = os.get_terminal_size() if t.stream.isatty() else os.terminal_size((100, 30))
                screen.draw(render(t, snap, size.columns, size.lines, alfred, note), size.columns, size.lines,
                            footer=1 + (1 if note else len(key_lines(t, size.columns))))
                key = keys.read(1.0)
                if key is None:
                    continue
                note = ""
                if key in ("q", "esc"):
                    return alfred.OK
                if key == "o":
                    import webbrowser
                    webbrowser.open(f"http://localhost:{layout.ui_port()}")
                    note = t.ok(f"opened http://localhost:{layout.ui_port()}")
                    continue
                action = ACTIONS.get(key)
                if not action:
                    continue
                stops_alfred = key in ("s", "r") and snap.status
                if stops_alfred:
                    word = "Stop" if key == "s" else "Restart"
                    screen.draw(render(t, snap, size.columns, size.lines, alfred,
                                       t.c(f"{word} Alfred?", "white", "bold") + t.c("  every process stops - calls made meanwhile are not logged   ", "dim")
                                       + t.c("y", "white", "bold") + t.c(" yes  ", "dim") + t.c("n", "white", "bold") + t.c(" no", "dim")), size.columns, size.lines)
                    if keys.read(30) != "y":
                        continue
                screen.leave()
                with suspended(keys):
                    try:
                        action(layout, alfred, snap)
                    except KeyboardInterrupt:
                        pass
                    except SystemExit as e:
                        if e.code not in (None, 0):
                            print(e.code)
                    print()
                    print("  " + t.c("any key returns to the panel", "dim"))
                keys.read(3600)
                screen.enter()
                reader = threading.Thread(target=snap.refresh, daemon=True)
                reader.start()
    except KeyboardInterrupt:
        return alfred.OK
    finally:
        signals.stop.set()
        screen.leave()


class suspended:
    """Ordinary line input while an action runs (its own prompts read whole lines)."""

    def __init__(self, keys):
        self.keys = keys

    def __enter__(self):
        if not WINDOWS:
            import termios
            termios.tcsetattr(self.keys.fd, termios.TCSADRAIN, self.keys.saved)

    def __exit__(self, *exc):
        if not WINDOWS:
            import tty
            tty.setcbreak(self.keys.fd)
        return False


def _start_stop(layout, alfred, snap):
    return alfred.cmd_stop(layout, []) if snap.status else alfred.cmd_start(layout, [])


def _triage(layout, alfred, snap):
    """The calls of the last hour that need attention (triage priority 1-3), worst first."""
    t = termlib.Term()
    since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    try:
        entries = snap.get("/triage/live?maxPriority=3&limit=25&since=" + urllib.request.quote(since), timeout=10)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(t.fail(f"triage did not answer: {e}"))
        return
    t.print("  " + t.brand("Calls that need attention", f"last hour {t.g['dot']} priority 1 is the worst"))
    t.print()
    if not entries:
        t.print("  " + t.ok("nothing in the last hour"))
        return
    t.print("   " + t.c(f"{'P':<3}{'TIME':<10}{'DIR':<5}{'METHOD':<8}{'STATUS':<8}{'WHY':<28}URL", "dim"))
    for e in sorted(entries, key=lambda e: (e.get("priority", 9), -e.get("startedAt", 0))):
        at = datetime.fromtimestamp(e.get("startedAt", 0) / 1000).strftime("%H:%M:%S") if e.get("startedAt") else "--:--:--"
        code = e.get("status")
        why = (e.get("error") or "")[:26]
        if not why:
            parts = []
            if e.get("failingChildren"):
                parts.append(f"{e['failingChildren']} supplier calls failed")
            if e.get("failedStatements"):
                parts.append(f"{e['failedStatements']} statements failed")
            why = ", ".join(parts)[:26] or ("still running" if e.get("state") == "IN_PROGRESS" else "")
        color = ("red", "bold") if (code or 0) >= 500 or e.get("priority", 9) <= 1 else ("yellow",)
        t.print("   " + t.c(f"{e.get('priority', '?'):<3}", *color) + t.c(f"{at:<10}", "dim") + f"{('IN' if e.get('direction') == 'INBOUND' else 'OUT'):<5}"
                + f"{(e.get('method') or '')[:7]:<8}" + t.c(f"{str(code or '…'):<8}", *color) + f"{why:<28}" + (e.get("url") or "")[:80])
    t.print()
    t.print("  " + t.c("the full picture of one call: in the UI, or ask Claude (MCP: investigate_call)", "dim"))


def _attach(layout, alfred, snap):
    import attach_cli
    attach_cli.main(layout, "jvms", [])
    try:
        pid = input("\n  pid to attach (Enter = none): ").strip()
    except EOFError:
        return
    if pid.isdigit():
        attach_cli.main(layout, "attach", [pid])


ACTIONS = {
    "s": _start_stop,
    "r": lambda layout, alfred, snap: alfred.cmd_restart(layout, []),
    "p": lambda layout, alfred, snap: alfred.cmd_restart(layout, ["--proxies"]),
    "l": lambda layout, alfred, snap: alfred.cmd_logs(layout, ["backend", "-f"]),
    "u": lambda layout, alfred, snap: alfred.cmd_update(layout, []),
    "d": lambda layout, alfred, snap: alfred.cmd_doctor(layout, []),
    "a": _attach,
    "t": _triage,
}
