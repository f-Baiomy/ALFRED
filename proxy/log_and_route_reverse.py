"""
mitmproxy addon: logs traffic flowing through one reverse-mode listener PER NAMED PROJECT
(e.g. several WildFly-style apps, each already running on its own port), the same way
proxy/log_and_route.py logs proxy-aware Java clients - two-phase (prepare/complete) webhook
POSTs to backend, reusing the same X-Request-Id/X-Session-ID/X-Operation-Id convention.

This addon does NOT route. reverse-proxy-entrypoint.sh gives mitmdump one
"--mode reverse:http://<upstreamHost>:<upstreamPort>@<listenPort>" flag per project from
REVERSE_PROXY_PORT_MAP ("name:listenPort:upstreamPort" triples), so each listener already has
its own fixed upstream and mitmproxy forwards on its own. All this addon does is work out WHICH
project a flow belongs to - from the port it arrived on, i.e. flow.client_conn.sockname - so it
can label the call and honour that project's logging toggle. Nothing here depends on the
request's contents, which is the point: an earlier revision routed by Host header instead and
broke in two separate ways (mitmproxy rewrites Host before addon hooks run, and Docker Desktop
leaks the host's hosts file into container DNS - see docs/supplier-integrations.md).

Routing by arrival port also means callers stay on "localhost" (just a different port), which
is what keeps browser session cookies working: a per-project hostname would make every API call
cross-site, and browsers drop SameSite=Lax cookies there.

Logging can be toggled on/off live, per NAME, without restarting this container, by writing
"name=on"/"name=off" lines to TOGGLE_FILE (see toggle-wildfly-reverse-proxy.sh/.bat at the
repo root, or the Settings UI's per-service switches) - the file is re-read (cheaply, via
mtime) on every request rather than only at startup. A name with no line in the file yet
defaults to enabled. Forwarding is entirely mitmproxy's own and happens regardless of any
name's toggle state - turning a project's logging off never stops its traffic, only whether its
calls get recorded; other projects' toggles are unaffected.
"""

import asyncio
import json
import os
import queue
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

from mitmproxy import ctx, http

import breakpoints
import interception

BODY_LIMIT = int(os.environ.get('BODY_LIMIT', '0'))

WEBHOOK_URL = os.environ.get('WEBHOOK_URL')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')
WEBHOOK_TIMEOUT_SECONDS = 2
PREPARE_TIMEOUT_SECONDS = float(os.environ.get('PREPARE_TIMEOUT_SECONDS', '2'))

# Fallback label for a flow whose arrival port isn't in PORT_MAP. Shouldn't normally happen
# (this process only listens on ports that ARE in the map), so it exists to keep an unexpected
# flow visible and toggleable rather than silently unlabelled - must not collide with a real
# configured name (see docs/supplier-integrations.md).
UNKNOWN_NAME = 'unknown'

# Written by toggle-wildfly-reverse-proxy.sh/.bat (or the Settings UI, via backend) on the
# host, bind-mounted into this container - see docker-compose.yml's reverse-proxy service.
# One "name=on"/"name=off" line per project; a name with no line defaults to enabled, so
# logging works out of the box for every project the moment it's added to REVERSE_PROXY_PORT_MAP.
TOGGLE_FILE = os.environ.get('TOGGLE_FILE', '/home/mitmproxy/reverse-proxy-enabled.flag')

# "name:listenPort:upstreamPort" triples, comma-separated - the same value
# reverse-proxy-entrypoint.sh turned into one --mode flag per project. PORT_MAP:
# {listenPort -> (name, upstreamPort)}, keyed on arrival port since that's what identifies a
# project here. upstreamPort is only used to report where a call actually went.
UPSTREAM_HOST = os.environ.get('REVERSE_PROXY_UPSTREAM_HOST', 'host.docker.internal')
PORT_MAP = {}
for _triple in os.environ.get('REVERSE_PROXY_PORT_MAP', '').split(','):
    _triple = _triple.strip()
    if not _triple:
        continue
    _name, _listen_port, _upstream_port = _triple.split(':', 2)
    PORT_MAP[int(_listen_port)] = (_name.strip(), int(_upstream_port))

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
    """Re-reads TOGGLE_FILE only when its mtime changes - same cache-validated-by-mtime idiom the backend's file adapters use, so a live toggle flip is picked up on the very next request without stat-ing the file more than once per change. One "name=on"/"name=off" line per project; a name with no line (including one never toggled, or a brand-new project just added to REVERSE_PROXY_PORT_MAP) defaults to enabled."""

    def __init__(self):
        self._mtime = None
        self._states = {}

    def enabled(self, name):
        try:
            mtime = os.path.getmtime(TOGGLE_FILE)
        except OSError:
            # File absent (never created, or removed) - default to enabled rather than
            # silently going dark the moment the bind-mounted file happens to be missing.
            return True
        if mtime != self._mtime:
            self._mtime = mtime
            states = {}
            try:
                with open(TOGGLE_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line or '=' not in line:
                            continue
                        line_name, value = line.split('=', 1)
                        states[line_name.strip()] = value.strip().lower() != 'off'
            except OSError:
                pass
            self._states = states
        return self._states.get(name, True)


_toggle = _ToggleState()


ENGINE = interception.InterceptionEngine('inbound')


class RouteAndLog:

    async def request(self, flow):
        flow.metadata['start_time'] = time.time()

        # Identify the project by the port this flow ARRIVED on - each listener was created with
        # its own upstream by reverse-proxy-entrypoint.sh, so mitmproxy has already decided where
        # this goes and nothing here touches the destination. Purely labelling, for the logging
        # toggle below and for the recorded url.
        listen_port = self._listen_port(flow)
        name, upstream_port = PORT_MAP.get(listen_port, (UNKNOWN_NAME, None))
        flow.metadata['service_name'] = name

        # Interception is independent of the per-project LOGGING toggle: turning a project's
        # recording off means "don't write this down", not "stop applying the rules I configured".
        # It also runs before the call is logged, so what is recorded is what was actually
        # forwarded upstream.
        verdict = ENGINE.apply_request(flow, name)
        flow.metadata['interception'] = verdict

        if not WEBHOOK_URL or not _toggle.enabled(name):
            await self._carry_out(flow, verdict, None, name)
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
            # original_url = what the client called (its own Host header, e.g.
            # http://localhost:9001/...; intact thanks to keep_host_header - see
            # reverse-proxy-entrypoint.sh); url = where mitmproxy forwarded it, i.e. this
            # project's real upstream. Built by hand rather than read off pretty_url, which
            # reflects the Host header either way and so can't show the upstream at all.
            'original_url': self._client_url(flow),
            'url': (f'{flow.request.scheme}://{UPSTREAM_HOST}:{upstream_port}{flow.request.path}'
                    if upstream_port is not None else self._client_url(flow)),
            'method': flow.request.method,
            'request': {
                'headers': dict(flow.request.headers),
                'body': self._safe_body(flow.request),
            },
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'session_id': session_id,
            'operation_id': operation_id,
            # Which configured project this arrived on (or UNKNOWN_NAME) - lets the dashboard tag
            # each call and filter by source without re-deriving it from the URL/port.
            'service_name': name,
        }
        applied = verdict.as_log()
        if applied:
            call_log['interception'] = applied
        _webhook_queue.put_nowait(('prepare', call_id, call_log))

        await self._carry_out(flow, verdict, call_id, name)

    async def _carry_out(self, flow, verdict, call_id, service_name):
        """See log_and_route.py's identical method for why every wait here is asyncio.sleep and
        never time.sleep: one blocked hook freezes every other connection this process is
        proxying."""
        if verdict.delay_ms:
            await asyncio.sleep(min(verdict.delay_ms, interception.MAX_DELAY_MS) / 1000.0)

        if verdict.terminal == 'MOCK_RESPONSE':
            mock = verdict.mock or {}
            flow.response = http.Response.make(
                mock.get('status', 200),
                (mock.get('body') or '').encode('utf-8'),
                mock.get('headers') or {},
            )
            return

        if verdict.terminal == 'ABORT_REQUEST':
            flow.kill()
            return

        if verdict.pause and verdict.pause.get('phase') == 'request' and call_id:
            decision = await breakpoints.wait_for_decision(
                flow, 'request', call_id, verdict.pause, 'inbound', service_name)
            self._record_decision(flow, verdict, 'request', decision)

    def _record_decision(self, flow, verdict, phase, decision):
        if (decision or {}).get('action') == 'abort':
            verdict.applied.append(interception.Applied(
                verdict.pause.get('ruleId'), verdict.pause.get('ruleName'),
                'BREAKPOINT_ABORT', (decision or {}).get('reason') or 'aborted by user'))
            flow.kill()
            return
        summary = interception.apply_decision(flow, phase, decision or {})
        verdict.applied.append(interception.Applied(
            verdict.pause.get('ruleId'), verdict.pause.get('ruleName'),
            'BREAKPOINT_RELEASE', summary))

    async def response(self, flow):
        call_id = flow.metadata.get('call_id')
        verdict = flow.metadata.get('interception') or interception.Verdict()
        service_name = flow.metadata.get('service_name')

        response_verdict = ENGINE.apply_response(flow, service_name)
        verdict.applied.extend(response_verdict.applied)
        if response_verdict.delay_ms:
            await asyncio.sleep(min(response_verdict.delay_ms, interception.MAX_DELAY_MS) / 1000.0)
        if response_verdict.pause and call_id:
            verdict.pause = response_verdict.pause
            decision = await breakpoints.wait_for_decision(
                flow, 'response', call_id, response_verdict.pause, 'inbound', service_name)
            flow.metadata['upstream_response'] = {
                'status': flow.response.status_code,
                'headers': dict(flow.response.headers),
                'body': self._safe_body(flow.response),
            }
            self._record_decision(flow, verdict, 'response', decision)
            if flow.response is None:
                return

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
        applied = verdict.as_log()
        if applied:
            upstream = flow.metadata.get('upstream_response')
            if upstream:
                applied['upstreamResponse'] = upstream
            data['interception'] = applied
        self._write(call_id, data)

        if ctx.options.flow_detail > 0:
            print(f"[{datetime.now(timezone.utc).isoformat()}] {flow.request.method} {flow.request.pretty_url} "
                  f"-> {flow.response.status_code} ({duration_ms}ms)")

    def error(self, flow):
        call_id = flow.metadata.get('call_id')
        if not call_id:
            return

        data = {'error': str(flow.error)}
        verdict = flow.metadata.get('interception')
        applied = verdict.as_log() if verdict else None
        if applied:
            data['interception'] = applied
        if flow.response is not None:
            start_time = flow.metadata.get('start_time', time.time())
            data['duration_ms'] = round((time.time() - start_time) * 1000, 2)
            data['response'] = {
                'status': flow.response.status_code,
                'headers': dict(flow.response.headers),
                'body': self._safe_body(flow.response),
            }
        self._write(call_id, data)

    def _listen_port(self, flow):
        """Which of this process's listeners the flow came in on - client_conn.sockname is OUR
        side of the client connection, so its port is the --mode listen port. Falls back to the
        port in the client's own Host header (kept intact by keep_host_header), which is the
        same number for any client that reached us normally."""
        try:
            return int(flow.client_conn.sockname[1])
        except (AttributeError, IndexError, TypeError, ValueError):
            host_header = (flow.request.headers.get('Host') or '').strip()
            _, _, port = host_header.rpartition(':')
            try:
                return int(port)
            except ValueError:
                return -1

    def _client_url(self, flow):
        """What the client actually asked for, rebuilt from its own Host header rather than
        pretty_url so it always shows the address the caller used (e.g. localhost:9001)."""
        host_header = (flow.request.headers.get('Host') or '').strip()
        if not host_header:
            return flow.request.pretty_url
        return f'{flow.request.scheme}://{host_header}{flow.request.path}'

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
