"""The application behind the reverse proxy in the inbound E2E stack (tests/e2e/compose.e2e.yml, service e2e-upstream).

Every request is answered with JSON echoing what arrived, so a stored call's request and response can be checked
against each other. Query switches: status=N answers with status N, ms=N waits N ms first, kb=N pads the answer to
about N KB (a big body).
"""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Echo(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle_any(self):
        query = parse_qs(urlparse(self.path).query)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace") if length else ""
        if "ms" in query:
            time.sleep(int(query["ms"][0]) / 1000)
        answer = {"method": self.command, "path": self.path, "body": body,
                  "requestId": self.headers.get("X-Request-Id")}
        if "kb" in query:
            answer["padding"] = "x" * (int(query["kb"][0]) * 1024)
        payload = json.dumps(answer).encode("utf-8")
        self.send_response(int(query.get("status", ["200"])[0]))
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = handle_any

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Echo).serve_forever()
