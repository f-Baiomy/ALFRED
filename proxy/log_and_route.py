"""
mitmproxy addon: dynamically routes ANY hostname ending in "-proxy" to its
real backend (by stripping the "-proxy" suffix), and POSTs every finished
request/response (url, method, headers, body, status, timing) to
pennyworth's webhook.

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

This addon does not persist anything itself - pennyworth owns storage
(RECENT_CALLS.log, written after a successful webhook call). That means
WEBHOOK_URL is not really optional: if it's unset, calls are proxied
correctly but never recorded anywhere.
"""

import json
import os
import queue
import threading
import time
import urllib.request
from datetime import datetime, timezone

SUFFIX = "-proxy"

# Max characters to log per body. 0 (the default) means no truncation -
# full request/response bodies are always logged in full. Override with
# the BODY_LIMIT env var if you ever want to cap it again, e.g. for very
# large/binary responses.
BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))

# Every finished call is POSTed here for pennyworth to persist and relay to
# the dashboard over WebSocket - see the module docstring above.
WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
WEBHOOK_TIMEOUT_SECONDS = 2

# mitmproxy's request()/response()/error() hooks run inline on its asyncio
# event loop - a blocking HTTP call inside one of them would stall every
# concurrent connection being proxied. So the webhook POST happens on a
# single background thread pulling off a queue, never inline in a hook.
_webhook_queue = queue.Queue()


def _webhook_worker():
    while True:
        data = _webhook_queue.get()
        try:
            request = urllib.request.Request(
                WEBHOOK_URL,
                data=json.dumps(data).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'X-Webhook-Secret': WEBHOOK_SECRET,
                },
                method='POST',
            )
            urllib.request.urlopen(request, timeout=WEBHOOK_TIMEOUT_SECONDS)
        except Exception as e:
            # A webhook failure must never affect proxying - it just means
            # this particular call never reaches pennyworth (nothing else
            # in this addon persists it as a fallback, see module docstring).
            print(f"[webhook] failed to notify {WEBHOOK_URL}: {e}")


if WEBHOOK_URL:
    threading.Thread(target=_webhook_worker, daemon=True).start()


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
        if WEBHOOK_URL:
            _webhook_queue.put_nowait(data)


addons = [RouteAndLog()]
