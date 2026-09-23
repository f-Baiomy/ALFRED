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

Per-project OUTBOUND attribution: docker-compose.yml's proxy service now starts with the usual
default forward-mode listener PLUS one extra forward-mode listener PER PROJECT that's opted into
outbound attribution (settings.properties's internal_call_services 4th/5th fields,
outboundProxyHost[:outboundProxyPort]) - see proxy/forward-proxy-entrypoint.sh, which turns
FORWARD_PROXY_PORT_MAP ("name:internalPort" pairs) into one "--mode regular@<port>" flag per
project, mirroring exactly how log_and_route_reverse.py's REVERSE_PROXY_PORT_MAP/--mode
reverse:...@<port> pattern works for the inbound side. A project's own outbound HTTP client (any
language) points its proxy settings at its own dedicated outboundProxyHost:outboundProxyPort, and
this addon works out which project a flow belongs to from the internal port it arrived on
(flow.client_conn.sockname, same technique log_and_route_reverse.py's _listen_port() already
uses) - a structural, certain fact, not a guess from the destination. A flow arriving on the
DEFAULT/shared port (not project-specific) resolves no service_name and stays "External" with no
attribution, exactly as before this feature existed - strictly additive, no regression for
anyone not opted in.

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

# "name:internalPort" pairs, comma-separated - built by start.py/restart.py from
# settings.properties's internal_call_services (its optional 4th/5th fields,
# outboundProxyHost[:outboundProxyPort]) and turned into extra "--mode regular@<port>" listeners
# by proxy/forward-proxy-entrypoint.sh, one per project that opted into outbound attribution -
# see the module docstring. FORWARD_PORT_MAP: {internalPort -> name}. Only the internal port
# assignment matters here; the public outboundProxyHost:outboundProxyPort a project's own client
# actually points at is resolved to this internal port entirely by Docker's own port publish
# (docker-compose.override.yml), so this addon never needs to know it.
FORWARD_PORT_MAP = {}
for _pair in os.environ.get('FORWARD_PROXY_PORT_MAP', '').split(','):
    _pair = _pair.strip()
    if not _pair:
        continue
    _name, _, _port = _pair.rpartition(':')
    if not _name or not _port.isdigit():
        continue
    FORWARD_PORT_MAP[int(_port)] = _name

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


ENGINE = interception.InterceptionEngine('outbound')


class RouteAndLog:

    async def request(self, flow):
        flow.metadata['start_time'] = time.time()

        # Which of this process's listeners the flow arrived on - the default/shared listener
        # resolves no name (FORWARD_PORT_MAP.get returns None), a project-specific one does. Set
        # regardless of WEBHOOK_URL below purely for parity with log_and_route_reverse.py; unlike
        # that file there's no per-project logging toggle to honour here, so this is only used
        # for the service_name tag on the payload further down.
        service_name = FORWARD_PORT_MAP.get(self._listen_port(flow))
        if service_name:
            flow.metadata['service_name'] = service_name

        # Interception runs BEFORE the call is logged, so what gets recorded is what was actually
        # sent upstream rather than what the client originally wrote - the log has to agree with
        # the traffic. It also runs regardless of WEBHOOK_URL: a deployment with no backend still
        # proxies, and a rule the user configured must still apply.
        verdict = await ENGINE.apply_request(flow, service_name)
        flow.metadata['interception'] = verdict

        if not WEBHOOK_URL:
            await self._carry_out(flow, verdict, None, service_name)
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

        # Resend linkage: X-Alfred-Resend-Of identifies the original call being resent,
        # X-Alfred-Resend-Edits carries the edits made (header names only per data model §7).
        # Both null for a normal call, only set when resending a logged call.
        resend_of = (flow.request.headers.get('X-Alfred-Resend-Of') or '').strip()
        resend_edits = (flow.request.headers.get('X-Alfred-Resend-Edits') or '').strip()

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
        # Only set when resolved - a call on the default/shared port stays unattributed
        # ("External" with no service_name at all), exactly as before this feature existed,
        # rather than noisily sending service_name: null for the common case.
        if service_name:
            call_log['service_name'] = service_name
        # Resend linkage only present for actual resends.
        if resend_of:
            call_log['resend_of'] = resend_of
            if resend_edits:
                call_log['resend_edits'] = resend_edits
        # Only present when a rule actually did something, so an untouched call's payload is
        # byte-identical to what it was before this feature existed.
        applied = verdict.as_log()
        if applied:
            call_log['interception'] = applied
        _webhook_queue.put_nowait(('prepare', call_id, call_log))

        await self._carry_out(flow, verdict, call_id, service_name)

    async def _carry_out(self, flow, verdict, call_id, service_name):
        """Everything in a request verdict that needs the event loop, in the order a client
        experiences it: wait, then short-circuit, then hold for a human.

        asyncio.sleep, never time.sleep - mitmproxy runs ONE event loop for every connection it is
        proxying, so a blocking sleep here would freeze every unrelated call in flight for the
        duration. This is the single most important line in the feature.

        Wrapped in try/finally because this is the LAST point at which the request still exists in
        its final form, and an aborted or mocked call leaves by one of the early returns. Missing
        the snapshot on exactly the paths that changed the most would be the wrong failure.
        """
        try:
            await self._decide(flow, verdict, call_id, service_name)
        finally:
            verdict.finalize_request(flow)

    async def _decide(self, flow, verdict, call_id, service_name):
        if verdict.delay_ms:
            await asyncio.sleep(min(verdict.delay_ms, interception.MAX_DELAY_MS) / 1000.0)

        if verdict.terminal == 'MOCK_RESPONSE':
            mock = verdict.mock or {}
            body = mock.get('body_bytes')
            flow.response = http.Response.make(
                mock.get('status', 200),
                body if body is not None else (mock.get('body') or '').encode('utf-8'),
                mock.get('headers') or {},
            )
            if verdict.refresh_from is not None:
                interception.refresh_dates(flow.response, verdict.refresh_from)
            return

        if verdict.terminal == 'ABORT_REQUEST':
            flow.kill()
            return

        if verdict.terminal == 'SIMULATE_FAILURE':
            await self._fail(flow, verdict.failure)
            return

        if verdict.pause and verdict.pause.get('phase') == 'request' and call_id:
            decision = await breakpoints.wait_for_decision(
                flow, 'request', call_id, verdict.pause, 'outbound', service_name)
            await self._record_decision(flow, verdict, 'request', decision)

    async def _fail(self, flow, failure):
        """Carries out a SIMULATE_FAILURE verdict.

        The decision of what each mode means lives in interception.failure_plan, shared with the
        inbound addon; the only thing that belongs here is the pair of lines that touch mitmproxy.
        The sleep is asyncio's, for the reason at the top of _carry_out.
        """
        plan = interception.failure_plan(failure)
        if plan['sleep']:
            await asyncio.sleep(plan['sleep'])
        spec = plan['response']
        if spec is not None:
            response = http.Response.make(
                spec['status'], (spec['body'] or '').encode('utf-8'), spec['headers'])
            declared = spec.get('declaredLength')
            if declared is not None:
                # Set LAST and by hand: assigning content recomputes content-length, and a
                # truncated reply is precisely a body that does not match the length it promises.
                response.headers['content-length'] = str(declared)
            flow.response = response
            return
        if plan['kill']:
            flow.kill()

    async def _record_decision(self, flow, verdict, phase, decision):
        # No snapshotting here. A pause is itself an action on a matched rule, so the engine
        # already froze this half before the pause was even decided on - see
        # Verdict.observe_request - and the finalize at the end of the phase picks up whatever a
        # human did to it.
        interception.note_decision(flow, phase, verdict.pause, decision)
        if (decision or {}).get('action') == 'abort':
            verdict.applied.append(interception.Applied(
                verdict.pause.get('ruleId'), verdict.pause.get('ruleName'),
                'BREAKPOINT_ABORT', (decision or {}).get('reason') or 'aborted by user'))
            flow.kill()
            return
        if (decision or {}).get('action') == 'simulate_failure':
            # The SAME SIMULATE_FAILURE a rule already carries out, chosen here by a human for one
            # call instead of ahead of time by a rule for every call it matches - see _fail. A
            # mode means exactly the same thing either way, because this is the same function.
            failure = (decision or {}).get('failure') or {}
            mode = (failure.get('mode') or '').strip().upper()
            await self._fail(flow, failure)
            verdict.applied.append(interception.Applied(
                verdict.pause.get('ruleId'), verdict.pause.get('ruleName'),
                'BREAKPOINT_SIMULATE_FAILURE', f'network failure: {mode or "(none)"}'))
            return
        summary = interception.apply_decision(flow, phase, decision or {})
        verdict.applied.append(interception.Applied(
            verdict.pause.get('ruleId'), verdict.pause.get('ruleName'),
            'BREAKPOINT_RELEASE', summary))

    def _close_card(self, flow, call_id, outcome, note=None):
        """Fills in the end of the cycle on the inspector card, if this call left one.

        Fire-and-forget by construction (see breakpoints.report_completed) and skipped entirely
        for the overwhelmingly common case of a call nobody paused, so normal traffic pays
        nothing at all for this.
        """
        if call_id and flow.metadata.get(interception.CARD_KEY):
            breakpoints.report_completed(flow, call_id, outcome, note)

    async def response(self, flow):
        call_id = flow.metadata.get('call_id')
        verdict = flow.metadata.get('interception') or interception.Verdict()

        # Response-phase rules apply whether or not this call is being logged - same reasoning as
        # the request side.
        response_verdict = await ENGINE.apply_response(flow, flow.metadata.get('service_name'))
        # State, not one field: adopt carries the pre-action snapshot across too, which copying
        # `applied` alone silently dropped - so no response action has ever produced a
        # before/after. See Verdict.adopt.
        verdict.adopt(response_verdict)
        if response_verdict.delay_ms:
            await asyncio.sleep(min(response_verdict.delay_ms, interception.MAX_DELAY_MS) / 1000.0)
        # A rule may pause here, and so may the user: releasing a request with "stop again when
        # the answer arrives" ticked means this half stops too, without any rule saying so.
        pause = response_verdict.pause or interception.follow_pause(flow)
        if pause and call_id:
            verdict.pause = pause
            decision = await breakpoints.wait_for_decision(
                flow, 'response', call_id, pause, 'outbound',
                flow.metadata.get('service_name'))
            await self._record_decision(flow, verdict, 'response', decision)
            if flow.response is None:
                verdict.finalize_response(flow)
                self._close_card(flow, call_id, 'aborted')
                return

        # Everything - rules, delay, a human's edit - has finished with this response.
        verdict.finalize_response(flow)
        self._close_card(flow, call_id, 'completed')

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
            'timing': self._phase_timing(flow),
        }
        applied = verdict.as_log()
        if applied:
            data['interception'] = applied
        self._write(call_id, data)

        # Ties this addon's own per-call line to mitmdump's own -q/-v flags
        # (flow_detail 0 = -q) instead of a separate toggle - `mitmdump -q`
        # (the default in docker-compose.yml) is silent end to end.
        if ctx.options.flow_detail > 0:
            print(f"[{datetime.now(timezone.utc).isoformat()}] {flow.request.method} {flow.request.pretty_url} "
                  f"-> {flow.response.status_code} ({duration_ms}ms)")

    def error(self, flow):
        call_id = flow.metadata.get('call_id')
        # Done before the early return: a followed call that died here would otherwise leave its
        # card spinning "in flight" until the hour-long backstop swept it up, which reads as
        # Alfred having lost the call rather than the call having failed.
        self._close_card(flow, call_id, 'failed', str(flow.error))
        if not call_id:
            return

        data = {'error': str(flow.error)}
        # A call killed by ABORT_REQUEST or by a breakpoint abort lands here rather than in
        # response(), so the interception record has to be attached on this path too - otherwise
        # the most drastic thing a rule can do is the one thing the log never mentions.
        verdict = flow.metadata.get('interception')
        applied = verdict.as_log() if verdict else None
        if applied:
            data['interception'] = applied
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

    def _listen_port(self, flow):
        """Which of this process's listeners the flow came in on - client_conn.sockname is OUR
        side of the client connection, so its port is the --mode listen port (mirrors
        log_and_route_reverse.py's _listen_port() exactly). Unlike that file there's no Host-header
        fallback here: forward mode's Host header (or CONNECT target) reflects the real
        destination the client asked for, not anything about which of our own listeners it used,
        so there's nothing meaningful to fall back to - an unresolvable sockname just returns -1,
        which never matches a configured internal port and so resolves no service_name."""
        try:
            return int(flow.client_conn.sockname[1])
        except (AttributeError, IndexError, TypeError, ValueError):
            return -1

    def _phase_timing(self, flow):
        """Splits one call's duration into connect / TLS / waiting / download.

        This is the difference between "the supplier took 5.7s" and knowing WHY: a big
        time-to-first-byte means the upstream is thinking, a big download means the payload is
        large, and a big connect+TLS share means connections aren't being reused - which is a fix
        on our side, not theirs.

        Every field is optional and any of them may come back None. In particular, mitmproxy
        REUSES server connections: when it does, server_conn's handshake timestamps are from
        whenever that connection was first opened, which can be many calls ago. Attributing them to
        this call would invent connect/TLS time that this request never spent, so they're reported
        only when the handshake actually happened after this request began. `reused_connection`
        says which case it was, since "no connect time because we reused a socket" is itself worth
        knowing (it's the healthy case, and its absence explains connection churn).
        """
        try:
            request = flow.request
            response = flow.response
            server = flow.server_conn
            request_start = getattr(request, 'timestamp_start', None)

            def span(earlier, later):
                if earlier is None or later is None or later < earlier:
                    return None
                return round((later - earlier) * 1000, 2)

            tcp_setup = getattr(server, 'timestamp_tcp_setup', None)
            fresh = (
                request_start is not None
                and tcp_setup is not None
                and tcp_setup >= request_start
            )

            return {
                'connect_ms': span(getattr(server, 'timestamp_start', None), tcp_setup) if fresh else None,
                'tls_ms': span(tcp_setup, getattr(server, 'timestamp_tls_setup', None)) if fresh else None,
                # From "request fully sent" to "first byte back" - the upstream's own think time.
                'ttfb_ms': span(getattr(request, 'timestamp_end', None), getattr(response, 'timestamp_start', None)),
                'download_ms': span(getattr(response, 'timestamp_start', None), getattr(response, 'timestamp_end', None)),
                'reused_connection': not fresh,
            }
        except Exception:
            # Timing is a diagnostic extra; never let a missing attribute on some exotic flow stop
            # the call itself being logged.
            return None

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
