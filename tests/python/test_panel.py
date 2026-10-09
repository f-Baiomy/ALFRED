"""packaging/launcher/panel.py: what the live panel shows from what it read, that it refreshes on the backend's
WebSocket signal (no polling), and that a frame never outgrows the window."""

import base64
import hashlib
import io
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "packaging", "launcher"))

import alfred  # noqa: E402
import panel  # noqa: E402
import term  # noqa: E402
from layout import Layout  # noqa: E402


class FakeTty(io.StringIO):
    encoding = "utf-8"

    def isatty(self):
        return True


def call(seconds_ago, status=200, method="GET", url="http://localhost:8081/api/orders"):
    return {"timestamp": (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat(), "status": status,
            "method": method, "url": url, "duration_ms": 35}


class RenderTest(unittest.TestCase):

    def setUp(self):
        home = tempfile.mkdtemp(prefix="alfred-panel-")
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, "app"))
        open(os.path.join(home, "app", "VERSION"), "w").write("3.0.5\n")
        open(os.path.join(home, ".env"), "w").write("ALFRED_UI_PORT=3100\n")
        self.layout = Layout(home)
        patch = mock.patch.object(self.layout, "settings", lambda: {"ALFRED_UI_PORT": "3100"})
        patch.start()
        self.addCleanup(patch.stop)
        self.snap = panel.Snapshot(self.layout, alfred)
        self.snap.status = {"version": "3.0.5", "processes": [
            {"name": "BACKEND", "state": "RUNNING", "pid": 1, "startedAt": None, "restarts": 0, "listeners": ["0.0.0.0:3000 (UI)"]},
            {"name": "REVERSE", "state": "CRASHED", "pid": 0, "startedAt": None, "restarts": 3, "listeners": ["8081 -> 8080 (odeysys)"]}],
            "agents": [{"project": "odeysys", "state": "ATTACHED", "pid": 7720, "features": "db,logs"},
                       {"project": "billing", "state": "NO_JVM"}]}
        self.snap.update = {"available": True, "latestVersion": "3.0.6", "job": {"state": "IDLE"}}
        self.snap.stats = {"files": [{"name": "calls.db", "rows": 10, "sizeBytes": 2 * 1073741824}]}
        self.snap.attention = {"1": 2, "3": 1, "5": 40}
        self.snap.inbound = [call(5, 500, "POST"), call(20), call(200)]
        self.snap.outbound = [call(8, 200, url="https://payments.example/v2/charge")]
        self.t = term.Term(io.StringIO(), env={})

    def text(self, width=120, height=40):
        return "\n".join(panel.render(self.t, self.snap, width, height, alfred))

    def test_everything_it_read_is_on_the_screen(self):
        out = self.text()
        for piece in ("Alfred 3.0.5", "http://localhost:3100", "3.0.6", "backend", "running", "reverse", "crashed", "3",
                      "odeysys", "db,logs", "billing", "no jvm", "calls.db", "2.0 GB", "3 calls in the last hour",
                      "payments.example/v2/charge", "/api/orders", "500", "q quit"):
            self.assertIn(piece, out)

    def test_the_last_minute_counts_only_calls_of_the_last_minute(self):
        out = self.text()
        self.assertIn("2/min", out)   # inbound: 5 s and 20 s ago, not 200 s ago
        self.assertIn("1/min", out)   # outbound
        counts = panel.per_bucket(self.snap.inbound, datetime.now(timezone.utc))
        self.assertEqual(sum(counts), 2)
        self.assertEqual(len(panel.sparkline(counts)), 24)

    def test_a_stopped_alfred_says_s_starts_it(self):
        self.snap.status = None
        self.assertIn("s starts it", self.text())

    def test_narrow_windows_stack_and_a_frame_never_outgrows_the_window(self):
        lines = panel.render(self.t, self.snap, 70, 15, alfred)
        out = FakeTty()
        panel.Screen(out).draw(lines, 70, 15, footer=1 + len(panel.key_lines(self.t, 70)))
        self.assertLessEqual(out.getvalue().count("\n"), 14)
        tail = "\n".join(out.getvalue().split("\n")[-4:])
        for key in ("q quit", "s stop/start", "o open UI"):
            self.assertIn(key, tail)

    def test_not_a_terminal_means_no_panel(self):
        real = term.Term
        with mock.patch.object(panel.termlib, "Term", lambda *args, **kwargs: real(io.StringIO(), env={})):
            self.assertIsNone(panel.run(self.layout, alfred))


class SignalsTest(unittest.TestCase):
    """The panel re-reads when a channel says something changed - a local WebSocket server stands in for the backend."""

    def test_a_frame_on_a_channel_sets_changed(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen()
        port = server.getsockname()[1]
        sent = threading.Event()

        def serve():
            conn, _ = server.accept()
            head = b""
            while b"\r\n\r\n" not in head:
                head += conn.recv(1024)
            key = [line.split(b": ")[1] for line in head.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key")][0]
            accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
            conn.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            time.sleep(0.3)
            conn.sendall(bytes([0x81, 2]) + b"{}")
            sent.set()
            time.sleep(1)
            conn.close()

        threading.Thread(target=serve, daemon=True).start()
        signals = panel.Signals(port, channels=("/ws/calls",))
        signals.start()
        self.addCleanup(signals.stop.set)
        self.assertTrue(signals.changed.wait(5))       # connecting reads once
        signals.changed.clear()
        self.assertTrue(sent.wait(5))
        self.assertTrue(signals.changed.wait(5))       # the frame says something changed
        server.close()

    def test_frames_are_unmasked_and_pings_answered(self):
        a, b = socket.socketpair()
        self.addCleanup(a.close)
        self.addCleanup(b.close)
        mask = b"\x01\x02\x03\x04"
        payload = bytes(c ^ mask[i % 4] for i, c in enumerate(b"hello"))
        a.sendall(bytes([0x89, 0]) + bytes([0x81, 0x80 | 5]) + mask + payload)
        self.assertEqual(panel.read_frame(b), b"hello")
        pong = a.recv(16)
        self.assertEqual(pong[0], 0x8A)
        a.sendall(bytes([0x88, 0]))
        self.assertIsNone(panel.read_frame(b))


if __name__ == "__main__":
    unittest.main()
