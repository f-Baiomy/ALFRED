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

Both webhook calls are fully asynchronous, fire-and-forget, via one shared
background queue+thread - neither ever blocks mitmproxy's single asyncio
event loop (and therefore every other connection currently being proxied).
This only works because the call's id is generated right here in
request(), not handed back by backend's POST .../prepare response - unlike
the earlier design, request() never needs to wait on that response at all
before letting response()/error() later know which call to complete. A
single shared queue (rather than one queue per phase) also guarantees
prepare is always sent before complete for the same call, since request()
always enqueues the former before response()/error() can enqueue the
latter for the same flow - two independent queues/threads could otherwise
race and send complete first. If backend is unreachable or a request is
dropped, the call is simply never recorded (proxying itself is never
affected either way).
"""

import json
import os
import queue
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

from mitmproxy import ctx

# Max characters to log per body. 0 (the default) means no truncation -
# full request/response bodies are always logged in full. Override with
# the BODY_LIMIT env var if you ever want to cap it again, e.g. for very
# large/binary responses.
BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))

# Two-phase logging: POST {WEBHOOK_URL}/prepare at request time and POST
# {WEBHOOK_URL}/{id}/complete once the response/error arrives - both fully
# async via the one shared background queue+thread below (see module docstring).
WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
WEBHOOK_TIMEOUT_SECONDS = 2
# Kept as a separate, still-overridable constant even though prepare is no
# longer on the blocking path, since it's a distinct request shape/endpoint
# from complete and may warrant a different timeout later.
PREPARE_TIMEOUT_SECONDS = float(os.environ.get('PREPARE_TIMEOUT_SECONDS', '2'))

# request()/response()/error() only ever enqueue (never block) - see the module docstring.
# Items are ('prepare', call_id, data) or ('complete', call_id, data).
_webhook_queue = queue.Queue()


def _webhook_worker():
    while True:
        phase, call_id, data = _webhook_queue.get()
        url = f'{WEBHOOK_URL}/prepare' if phase == 'prepare' else f'{WEBHOOK_URL}/{call_id}/complete'
        timeout = PREPARE_TIMEOUT_SECONDS if phase == 'prepare' else WEBHOOK_TIMEOUT_SECONDS
        try:
            request = urllib.request.Request(
                url,
                data=json.dumps(data).encode('utf-8'),
                headers={
                    'Content-Type': 'application/json',
                    'X-Webhook-Secret': WEBHOOK_SECRET,
                },
                method='POST',
            )
            urllib.request.urlopen(request, timeout=timeout)
        except Exception as e:
            # A webhook failure must never affect proxying - it just means
            # this particular call's outcome never reaches backend. For
            # complete specifically, the call then stays logged as
            # in-progress forever - see the two-phase logging plan for why
            # that's an accepted gap, not handled here. A prepare failure
            # means a later complete() call for the same id just 404s
            # (backend never saw the prepare), logged the same harmless way.
            print(f"[webhook] {phase} failed to notify {WEBHOOK_URL} for {call_id}: {e}")


if WEBHOOK_URL:
    threading.Thread(target=_webhook_worker, daemon=True).start()


class RouteAndLog:

    def request(self, flow):
        flow.metadata['start_time'] = time.time()
        if not WEBHOOK_URL:
            return

        # Reuses the client's own X-Request-Id if it sent one (case-insensitive
        # header lookup, mitmproxy's headers object handles that) - lets a
        # caller correlate its own request id with the logged call directly,
        # without a separate lookup. Falls back to a freshly generated UUID
        # when the header is absent, empty, or blank. Generated/resolved here
        # rather than handed back by backend either way - lets prepare become
        # fire-and-forget (see module docstring) since response()/error()
        # already know which call to complete without waiting on anything.
        client_request_id = (flow.request.headers.get('X-Request-Id') or '').strip()
        call_id = client_request_id if client_request_id else str(uuid.uuid4())
        flow.metadata['call_id'] = call_id

        # Same reuse-or-generate rule as X-Request-Id above, one independent
        # UUID per header - a session groups related calls together, an
        # operation identifies one logical action that may itself span
        # several calls, and neither is derived from the other or from call_id.
        client_session_id = (flow.request.headers.get('X-Session-ID') or '').strip()
        session_id = client_session_id if client_session_id else str(uuid.uuid4())
        client_operation_id = (flow.request.headers.get('X-Operation-Id') or '').strip()
        operation_id = client_operation_id if client_operation_id else str(uuid.uuid4())

        call_log = {
            'id': call_id,
            'original_url': flow.request.pretty_url,
            'url': flow.request.pretty_url,
            'method': flow.request.method,
            'request': {
                'headers': dict(flow.request.headers),
                'body': self._safe_body(flow.request),
            },
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'session_id': session_id,
            'operation_id': operation_id,
        }
        _webhook_queue.put_nowait(('prepare', call_id, call_log))

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

        data = {'error': str(flow.error)}
        # This hook fires whenever mitmproxy couldn't deliver a response to
        # the client that made the original request - most commonly because
        # that client gave up and disconnected before the reply arrived, or
        # while it was still being sent. That does NOT mean the upstream
        # supplier never answered: if it already had, flow.response is still
        # fully populated in memory at this point (mitmproxy only failed the
        # final write-back to the client, not the read from the supplier) -
        # capture it so a real response is never silently lost. error stays
        # set either way, so it's still clear the client itself never saw it.
        if flow.response is not None:
            start_time = flow.metadata.get('start_time', time.time())
            data['duration_ms'] = round((time.time() - start_time) * 1000, 2)
            data['response'] = {
                'status': flow.response.status_code,
                'headers': dict(flow.response.headers),
                'body': self._safe_body(flow.response),
            }
        self._write(call_id, data)

    def _safe_body(self, message, limit=BODY_LIMIT):
        try:
            text = message.get_text(strict=False)
        except Exception:
            text = None
        if limit and text and len(text) > limit:
            text = text[:limit] + '...[truncated]'
        return text

    def _write(self, call_id, data):
        _webhook_queue.put_nowait(('complete', call_id, data))


addons = [RouteAndLog()]
