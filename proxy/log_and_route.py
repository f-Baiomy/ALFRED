"""
mitmproxy addon: runs as a standard HTTP/HTTPS forward proxy, and logs every
request/response pair to backend in two phases - once as soon as the
request is intercepted (before it's forwarded upstream), and again once
the response arrives (or the upstream call fails) - see docs/two-phase
logging in the backend for why: backend can then show a call as
"in progress" on the dashboard the instant it starts, not only once it
finishes.

Any HTTP/HTTPS-aware client that's been pointed at this proxy (e.g. via
http.proxyHost/https.proxyHost JVM system properties) gets every call it
makes logged automatically, for whatever real hostname it actually calls -
mitmproxy's regular (forward) mode (see docker-compose.yml's mitmdump
command) already resolves flow.request.host/pretty_url to the real
destination from the client's CONNECT request (HTTPS) or absolute-URI
(plain HTTP), so there's no hostname rewriting to do here.

This addon does not persist anything itself - backend owns storage. That
means WEBHOOK_URL is not really optional: if it's unset, calls are proxied
correctly but never recorded anywhere.

Concurrency trade-off, read before changing request(): every other hook in
this addon fires its webhook call asynchronously via a background queue
+thread specifically so a blocking HTTP call never stalls mitmproxy's
single asyncio event loop (and therefore every other connection currently
being proxied). request() is the one exception - it needs a real call id
back from backend's POST .../prepare *before* the request proceeds, so
response()/error() later know which call to complete. That means
request() blocks the event loop for the (normally few-ms, same-docker-
network) round trip to backend, bounded by PREPARE_TIMEOUT_SECONDS so a
backend hiccup adds at most that much latency to every concurrently-
proxied connection rather than hanging indefinitely. If backend is
unreachable or times out, the call is simply not logged at all (proxying
itself is never blocked - only delayed by up to the timeout).
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

# Two-phase logging: POST {WEBHOOK_URL}/prepare at request time (blocking,
# see the module docstring), then POST {WEBHOOK_URL}/{id}/complete once the
# response/error arrives (async, via the background queue+thread below,
# same as this addon's only webhook call used to work before two-phase
# logging existed).
WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
WEBHOOK_TIMEOUT_SECONDS = 2
# Short - this blocks mitmproxy's event loop (see module docstring), so the
# bound on "how much latency can one backend hiccup add to every proxied
# connection" needs to stay small. A local docker-network round trip is
# normally single-digit milliseconds.
PREPARE_TIMEOUT_SECONDS = float(os.environ.get('PREPARE_TIMEOUT_SECONDS', '1'))

# response()/error() only ever enqueue (never block) - see the module docstring.
_webhook_queue = queue.Queue()


def _webhook_worker():
    while True:
        call_id, data = _webhook_queue.get()
        try:
            request = urllib.request.Request(
                f'{WEBHOOK_URL}/{call_id}/complete',
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
            # this particular call's outcome never reaches backend (it stays
            # logged as in-progress forever - see the two-phase logging plan
            # for why that's an accepted gap, not handled here).
            print(f"[webhook] complete failed to notify {WEBHOOK_URL}: {e}")


if WEBHOOK_URL:
    threading.Thread(target=_webhook_worker, daemon=True).start()


class RouteAndLog:

    def request(self, flow):
        flow.metadata['start_time'] = time.time()
        if not WEBHOOK_URL:
            return

        call_log = {
            'original_url': flow.request.pretty_url,
            'url': flow.request.pretty_url,
            'method': flow.request.method,
            'request': {
                'headers': dict(flow.request.headers),
                'body': self._safe_body(flow.request),
            },
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }
        # None here (backend unreachable/timed out, or the host/URL filter
        # rejected this call) means response()/error() below have nothing
        # to complete - they check for this and skip, same as this addon's
        # single-phase predecessor skipped calls missing 'call_log'.
        flow.metadata['call_id'] = self._prepare(call_log)

    def response(self, flow):
        call_id = flow.metadata.get('call_id')
        if not call_id:
            return

        start_time = flow.metadata.get('start_time', time.time())
        duration_ms = round((time.time() - start_time) * 1000, 2)
        data = {
            'response': {
                'status': flow.response.status_code,
                'headers': dict(flow.response.headers),
                'body': self._safe_body(flow.response),
            },
            'duration_ms': duration_ms,
        }
        self._write(call_id, data)

        # Ties this addon's own per-call line to mitmdump's own -q/-v flags
        # (flow_detail 0 = -q) instead of a separate toggle - `mitmdump -q`
        # (the default in docker-compose.yml) is silent end to end.
        if ctx.options.flow_detail > 0:
            print(f"[{datetime.now(timezone.utc).isoformat()}] {flow.request.method} {flow.request.pretty_url} "
                  f"-> {flow.response.status_code} ({duration_ms}ms)")

    def error(self, flow):
        call_id = flow.metadata.get('call_id')
        if not call_id:
            return
        self._write(call_id, {'error': str(flow.error)})

    def _safe_body(self, message, limit=BODY_LIMIT):
        try:
            text = message.get_text(strict=False)
        except Exception:
            text = None
        if limit and text and len(text) > limit:
            text = text[:limit] + '...[truncated]'
        return text

    def _prepare(self, call_log):
        """Blocking (short-timeout) call to get a real id back before the request proceeds - see
        the module docstring for why this one call is deliberately not queued like the others."""
        try:
            request = urllib.request.Request(
                f'{WEBHOOK_URL}/prepare',
                data=json.dumps(call_log).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'X-Webhook-Secret': WEBHOOK_SECRET,
                },
                method='POST',
            )
            with urllib.request.urlopen(request, timeout=PREPARE_TIMEOUT_SECONDS) as response:
                if response.status == 204:
                    # Filtered out by backend's host/URL allow/block list - not an error.
                    return None
                body = json.loads(response.read().decode('utf-8'))
                return body.get('id')
        except Exception as e:
            print(f"[webhook] prepare failed to notify {WEBHOOK_URL}: {e}")
            return None

    def _write(self, call_id, data):
        _webhook_queue.put_nowait((call_id, data))


addons = [RouteAndLog()]
