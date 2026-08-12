"""
mitmproxy addon: runs as a standard HTTP/HTTPS forward proxy, and POSTs
every finished request/response (url, method, headers, body, status,
timing) to backend's webhook.

Any HTTP/HTTPS-aware client that's been pointed at this proxy (e.g. via
http.proxyHost/https.proxyHost JVM system properties) gets every call it
makes logged automatically, for whatever real hostname it actually calls -
mitmproxy's regular (forward) mode (see docker-compose.yml's mitmdump
command) already resolves flow.request.host/pretty_url to the real
destination from the client's CONNECT request (HTTPS) or absolute-URI
(plain HTTP), so there's no hostname rewriting to do here.

This addon does not persist anything itself - backend owns storage
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

from mitmproxy import ctx

# Max characters to log per body. 0 (the default) means no truncation -
# full request/response bodies are always logged in full. Override with
# the BODY_LIMIT env var if you ever want to cap it again, e.g. for very
# large/binary responses.
BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))

# Every finished call is POSTed here for backend to persist and relay to
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
            # this particular call never reaches backend (nothing else
            # in this addon persists it as a fallback, see module docstring).
            print(f"[webhook] failed to notify {WEBHOOK_URL}: {e}")


if WEBHOOK_URL:
    threading.Thread(target=_webhook_worker, daemon=True).start()


class RouteAndLog:

    def request(self, flow):
        flow.metadata['start_time'] = time.time()
        flow.metadata['call_log'] = {
            'original_url': flow.request.pretty_url,
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

        # Ties this addon's own per-call line to mitmdump's own -q/-v flags
        # (flow_detail 0 = -q) instead of a separate toggle - `mitmdump -q`
        # (the default in docker-compose.yml) is silent end to end.
        if ctx.options.flow_detail > 0:
            print(f"[{data['timestamp']}] {data['method']} {data['url']} "
                  f"-> {data['response']['status']} ({duration_ms}ms)")

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
