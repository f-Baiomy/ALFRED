"""
mitmproxy addon: dynamically routes ANY hostname ending in "-proxy" to its
real backend (by stripping the "-proxy" suffix), and logs every request/
response (url, method, headers, body, status, timing) as JSON lines.

Works for unlimited suppliers with zero per-supplier configuration:
  https://ndc-integration-stg-ne-3.azurewebsites.net-proxy/...
    -> forwarded to https://ndc-integration-stg-ne-3.azurewebsites.net/...
  https://another-supplier.com-proxy/...
    -> forwarded to https://another-supplier.com/...

Runs in mitmproxy's reverse mode (see docker-compose.yml), so your client
(Java app) needs NO proxy configuration at all. Instead, each supplier's
"-proxy" hostname is pointed at this container via a Windows hosts file
entry, and this addon dynamically rewrites the destination per request
based on whatever hostname the client actually connected to.

Log file path is configurable via the LOG_FILE environment variable,
defaults to ./calls.log
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

SUFFIX = "-proxy"

LOG_FILE = Path(os.environ.get('LOG_FILE', './calls.log'))
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

# Max characters to log per body. 0 (the default) means no truncation -
# full request/response bodies are always logged in full. Override with
# the BODY_LIMIT env var if you ever want to cap it again, e.g. for very
# large/binary responses.
BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))


class RouteAndLog:

    def server_connect(self, data):
        """
        This is the hook that actually controls where mitmproxy dials out to.
        In reverse mode, changing flow.request.host in request() only affects
        the logical HTTP layer (Host header, logging) - NOT the real TCP/TLS
        connection target, which stays pinned to the static reverse-mode
        placeholder unless we override it here.

        We use the client's TLS SNI (the hostname it used to connect to us,
        e.g. "ndc-supplier-integration.azurewebsites.net-proxy") since that's
        known at connection time, before the HTTP request is even parsed.
        """
        sni = data.client.sni
        if sni and sni.endswith(SUFFIX):
            real_host = sni[: -len(SUFFIX)]
            data.server.address = (real_host, 443)
            # Without this, mitmproxy still sends the original "-proxy"
            # hostname as SNI in its own outbound TLS handshake to the real
            # backend, which fails certificate verification since the real
            # cert is issued for the real hostname, not "...-proxy".
            data.server.sni = real_host

    def request(self, flow):
        # In reverse mode, flow.request.host starts out as the static
        # placeholder target, NOT what the client actually asked for - so we
        # read the real intended hostname from the client's TLS SNI instead
        # (same source used in server_connect above).
        sni = flow.client_conn.sni
        original_host = sni if sni else flow.request.host

        if original_host.endswith(SUFFIX):
            real_host = original_host[: -len(SUFFIX)]

            # Keep the HTTP-layer view (Host header, logging) consistent
            # with the real backend. The actual connection target is
            # handled separately in server_connect above.
            flow.request.host = real_host
            flow.request.port = 443
            flow.request.headers["Host"] = real_host

        flow.metadata['start_time'] = time.time()
        flow.metadata['call_log'] = {
            'original_url': f"{flow.request.scheme}://{original_host}{flow.request.path}",
            'url': flow.request.pretty_url,
            'method': flow.request.method,
            'request': {
                'headers': dict(flow.request.headers),
                'body': self._safe_body(flow.request),
            },
        }

    def response(self, flow):
        if 'call_log' not in flow.metadata:
            return

        data = flow.metadata['call_log']
        start_time = flow.metadata.get('start_time', time.time())
        duration_ms = round((time.time() - start_time) * 1000, 2)

        data['timestamp'] = datetime.now(timezone.utc).isoformat()
        data['duration_ms'] = duration_ms
        data['response'] = {
            'status': flow.response.status_code,
            'headers': dict(flow.response.headers),
            'body': self._safe_body(flow.response),
        }
        self._write(data)

        print(f"[{data['timestamp']}] {data['method']} {data['original_url']} "
              f"-> {data['url']} -> {data['response']['status']} ({duration_ms}ms)")

    def error(self, flow):
        if 'call_log' not in flow.metadata:
            return
        data = flow.metadata['call_log']
        data['timestamp'] = datetime.now(timezone.utc).isoformat()
        data['error'] = str(flow.error)
        self._write(data)

    def _safe_body(self, message, limit=BODY_LIMIT):
        try:
            text = message.get_text(strict=False)
        except Exception:
            text = None
        if limit and text and len(text) > limit:
            text = text[:limit] + '...[truncated]'
        return text

    def _write(self, data):
        with open(LOG_FILE, 'a') as f:
            f.write(json.dumps(data) + '\n')


addons = [RouteAndLog()]
