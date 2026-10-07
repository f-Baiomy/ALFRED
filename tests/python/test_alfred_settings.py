"""alfred_settings.py: the grammar shared by start.py/restart.py and the native supervisor.

The same vectors run against the Java port (backend-server ServicesGrammarTest), so the two parsers
cannot drift apart (specs/012-server-program plan, Complexity Tracking row 2)."""

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

import alfred_settings  # noqa: E402

VECTORS = os.path.join(ROOT, "specs", "012-server-program", "fixtures", "services-grammar.json")
MITMDUMP = ["py", "-c", "from mitmproxy.tools.main import mitmdump; mitmdump()"]


def load_vectors():
    with open(VECTORS, encoding="utf-8") as f:
        return json.load(f)


class ServicesGrammarTest(unittest.TestCase):

    def test_every_service_vector(self):
        for vector in load_vectors()["services"]:
            with self.subTest(vector["input"]):
                parsed = alfred_settings.parse_service_entries(vector["input"])
                self.assertEqual([{
                    "name": e["name"], "listenPort": e["listen_port"], "upstreamPort": e["upstream_port"],
                    "outboundHost": e["outbound_host"], "outboundPort": e["outbound_port"],
                } for e in parsed], vector["entries"])
                self.assertEqual(alfred_settings.forward_proxy_port_map_env(vector["input"]),
                                 vector["forwardProxyPortMap"])

    def test_every_watch_dir_vector(self):
        for vector in load_vectors()["watchDirs"]:
            with self.subTest(vector["input"]):
                parsed = alfred_settings.parse_watch_dirs(vector["input"], warn=lambda message: None)
                self.assertEqual([{"name": n, "path": p} for n, p in parsed], vector["folders"])


class ProxyCommandLinesTest(unittest.TestCase):

    def lines(self, **env):
        return alfred_settings.proxy_command_lines(env, MITMDUMP, "/app/proxy", "/data/certs")

    def test_no_projects_means_outbound_only(self):
        lines = self.lines(REVERSE_PROXY_ENABLED="true", INTERNAL_CALL_SERVICES="")
        self.assertIsNone(lines["REVERSE"])
        self.assertIn("regular@127.0.0.2:443", lines["OUTBOUND"])
        self.assertEqual(lines["OUTBOUND"][:3], MITMDUMP)

    def test_inbound_off_starts_no_reverse_proxy_even_with_projects(self):
        lines = self.lines(REVERSE_PROXY_ENABLED="false", INTERNAL_CALL_SERVICES="a:9001:8080")
        self.assertIsNone(lines["REVERSE"])

    def test_one_reverse_listener_per_project_on_localhost(self):
        lines = self.lines(REVERSE_PROXY_ENABLED="true",
                           INTERNAL_CALL_SERVICES="a:9001:8080,b:9002:8083,c:9003:8085")
        modes = [lines["REVERSE"][i + 1] for i, arg in enumerate(lines["REVERSE"]) if arg == "--mode"]
        self.assertEqual(modes, ["reverse:http://127.0.0.1:8080@9001", "reverse:http://127.0.0.1:8083@9002",
                                 "reverse:http://127.0.0.1:8085@9003"])
        self.assertIn("keep_host_header=true", lines["REVERSE"])
        self.assertIn(os.path.join("/app/proxy", "log_and_route_reverse.py"), lines["REVERSE"])

    def test_outbound_attribution_binds_its_own_address(self):
        lines = self.lines(INTERNAL_CALL_SERVICES="a:9001:8080:wallet.local,b:9002:8081:card.local:8443",
                           ALFRED_OUTBOUND_PROXY_LISTEN="127.0.0.2:8443")
        modes = [lines["OUTBOUND"][i + 1] for i, arg in enumerate(lines["OUTBOUND"]) if arg == "--mode"]
        self.assertEqual(modes, ["regular@127.0.0.2:8443", "regular@wallet.local:443", "regular@card.local:8443"])
        self.assertIn("confdir=/data/certs", lines["OUTBOUND"])

    def test_split_listen(self):
        self.assertEqual(alfred_settings.split_listen("127.0.0.2:443"), ("127.0.0.2", 443))
        self.assertEqual(alfred_settings.split_listen("8443"), ("127.0.0.1", 8443))
        self.assertEqual(alfred_settings.split_listen("[::1]:8443"), ("::1", 8443))


if __name__ == "__main__":
    unittest.main()
