"""
mitmproxy addon: runs in reverse mode in front of an external WildFly server, so
browser traffic the frontend sends straight to WildFly can be logged the same way
proxy/log_and_route.py logs proxy-aware Java clients - two-phase (prepare/complete)
webhook POSTs to backend, reusing the same X-Request-Id/X-Session-ID/X-Operation-Id
convention.

Unlike log_and_route.py's forward-mode addon, the upstream here is fixed (passed via
mitmdump's own --mode reverse:<url> flag, not read from the request) - this addon only
adds logging on top of mitmproxy's normal reverse-mode forwarding, it never decides
where a request goes.

Logging can be toggled on/off live, without restarting this container, by writing
"on"/"off" to TOGGLE_FILE (see toggle-wildfly-reverse-proxy.sh/.bat at the repo root,
also wired into start.py/restart.py's --wildfly-reverse-proxy flag) - the file
is re-read (cheaply, via mtime) on every request rather than only at startup. Forwarding
itself is never affected by the toggle: a request is always relayed to WildFly either
way, only whether it gets logged changes. This means turning logging off does not free
the port or stop the container - see the toggle scripts' own doc for why that's the
point (the frontend keeps working at the same address regardless).
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

BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))

WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
WEBHOOK_TIMEOUT_SECONDS = 2
PREPARE_TIMEOUT_SECONDS = float(os.environ.get('PREPARE_TIMEOUT_SECONDS', '2'))

# Written by toggle-wildfly-reverse-proxy.sh/.bat on the host, bind-mounted into this
# container - see docker-compose.yml's reverse-proxy service. Missing entirely (e.g.
# volume not mounted yet) is treated as "on", so logging works out of the box.
TOGGLE_FILE = os.environ.get('TOGGLE_FILE', '/home/mitmproxy/reverse-proxy-enabled.flag')

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
            print(f"[webhook] {phase} failed to notify {WEBHOOK_URL} for {call_id}: {e}")


if WEBHOOK_URL:
    threading.Thread(target=_webhook_worker, daemon=True).start()


class _ToggleState:
    """Re-reads TOGGLE_FILE only when its mtime changes - same cache-validated-by-mtime idiom the backend's file adapters use, so a live toggle flip is picked up on the very next request without stat-ing the file more than once per change."""

    def __init__(self):
        self._mtime = None
        self._enabled = True

    def enabled(self):
        try:
            mtime = os.path.getmtime(TOGGLE_FILE)
        except OSError:
            # File absent (never created, or removed) - default to enabled rather than
            # silently going dark the moment the bind-mounted file happens to be missing.
            return True
        if mtime != self._mtime:
            self._mtime = mtime
            try:
                with open(TOGGLE_FILE, 'r', encoding='utf-8') as f:
                    self._enabled = f.read().strip().lower() != 'off'
            except OSError:
                self._enabled = True
        return self._enabled


_toggle = _ToggleState()


class RouteAndLog:

    def request(self, flow):
        flow.metadata['start_time'] = time.time()
        if not WEBHOOK_URL or not _toggle.enabled():
            return

        client_request_id = (flow.request.headers.get('X-Request-Id') or '').strip()
        call_id = client_request_id if client_request_id else str(uuid.uuid4())
        flow.metadata['call_id'] = call_id

        # No server-generated fallback for session/operation id - a request the frontend
        # never tagged simply has null for that field, matching backend's own rule (see
        # CallsService.receivePreparedCall).
        session_id = (flow.request.headers.get('X-Session-ID') or '').strip() or None
        operation_id = (flow.request.headers.get('X-Operation-Id') or '').strip() or None

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

        if ctx.options.flow_detail > 0:
            print(f"[{datetime.now(timezone.utc).isoformat()}] {flow.request.method} {flow.request.pretty_url} "
                  f"-> {flow.response.status_code} ({duration_ms}ms)")

    def error(self, flow):
        call_id = flow.metadata.get('call_id')
        if not call_id:
            return

        data = {'error': str(flow.error)}
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
