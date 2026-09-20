"""
The breakpoint side of interception: holding a call at Alfred while a human decides what happens
to it.

This is the one part of the feature that has to talk to the backend on the request path, and it
is worth being explicit about why that is acceptable here when it is not acceptable anywhere else
in this proxy. Ordinary rule evaluation is local precisely so that a backend restart can never
stall traffic (see interception.py). A breakpoint is the opposite by definition: the user has
ASKED for this call to stop until they say otherwise, so waiting is the feature, not a cost. The
properties that still have to hold are that only a paused flow ever waits, that waiting never
blocks any other connection, and that a call can never wait forever.

How the wait works:

    proxy                                   backend                         frontend
      |-- POST /interception/paused -------->|                                  |
      |   (the flow, as the user will see it)|-- WebSocket "paused" ----------->|
      |                                      |                          user edits + releases
      |-- GET .../decision?waitMs=... ------>| (long poll, held open)           |
      |<---------------- decision -----------|<---- POST .../decision ----------|
      |   apply + continue                   |                                  |

Long-polling rather than a listener on this side: mitmproxy's addon process has no HTTP server
and giving it one means a port, a bind address and a new attack surface in the container that
sits on every request. Polling in the other direction keeps the existing one-way proxy→backend
relationship that the webhook already established, and costs nothing at all when nothing is
paused, because nothing polls unless it is paused.

urllib is blocking, so every network call here is dispatched through the event loop's default
executor. Nothing in this module may be awaited from a hook without that.
"""

import asyncio
import json
import os
import urllib.error
import urllib.request

# Same host the webhook already targets, minus the per-slice path - derived from WEBHOOK_URL so a
# deployment that has already configured one address doesn't have to configure a second.
WEBHOOK_URL = os.environ.get('WEBHOOK_URL', '')
WEBHOOK_SECRET = os.environ.get('WEBHOOK_SECRET', '')


def _backend_base():
    """http://backend:5000/calls/webhook -> http://backend:5000"""
    explicit = os.environ.get('INTERCEPTION_API_URL')
    if explicit:
        return explicit.rstrip('/')
    if not WEBHOOK_URL:
        return ''
    marker = WEBHOOK_URL.find('/', WEBHOOK_URL.find('://') + 3)
    return WEBHOOK_URL[:marker] if marker > 0 else WEBHOOK_URL


BACKEND = _backend_base()

# How long one long-poll request may be held open by the backend before it answers "nothing yet".
# Shorter than any realistic pause timeout, so a pause is several polls rather than one - which is
# what lets the proxy notice a backend that has gone away and fall back to the timeout action
# instead of hanging on a dead socket.
POLL_WINDOW_SECONDS = 5

# Ceiling on one poll's socket timeout, slightly above the window so a healthy backend answering
# right at the deadline isn't treated as a failure.
POLL_TIMEOUT_SECONDS = POLL_WINDOW_SECONDS + 3

# Floor on how often this loop may ask, no matter how fast the answer comes back.
#
# The long poll assumes the backend HOLDS the request for the window it was given. When that
# assumption broke - a call the backend no longer had a handoff for was answered "nothing yet"
# instantly instead of "stop asking" - this loop re-asked with no delay and the proxy and backend
# spun at maximum request rate until the deadline, which after a take-control is an hour away.
# Measured at 60% CPU in the proxy and 35% in the backend from a SINGLE paused call, with no cpu
# limits on either container: enough to make the host, mouse included, stop responding.
#
# The backend now answers 404 in that case and this loop gives up on it. This floor exists anyway,
# because it makes the whole class of bug impossible rather than fixing the one instance: any
# early answer, from any cause - a proxy in front of the backend, a clamped waitMs, a future code
# path - costs at most this many requests per second instead of as many as the CPU allows.
MIN_POLL_INTERVAL_SECONDS = 0.25

# Registering a paused call has to be quick: it is on the path of a call the user is waiting for,
# and if the backend cannot be told about the pause there is nobody to make a decision anyway.
REGISTER_TIMEOUT_SECONDS = 3

# How long a call may stay held once somebody has taken control of it. "Until you decide" is the
# behaviour; this is only the backstop for a tab closed on a held call, and it must match the
# backend's own MAX_HELD_MS (BreakpointService) or one side would give up while the other waits.
MAX_HELD_SECONDS = int(os.environ.get('INTERCEPTION_MAX_HELD_SECONDS', str(60 * 60)))


def _post(path, payload, timeout):
    request = urllib.request.Request(
        f'{BACKEND}{path}',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode('utf-8')
    return json.loads(body) if body else None


def _get(path, timeout):
    request = urllib.request.Request(
        f'{BACKEND}{path}',
        headers={'X-Webhook-Secret': WEBHOOK_SECRET},
        method='GET',
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status == 204:
            return None
        body = response.read().decode('utf-8')
    return json.loads(body) if body else None


def snapshot(flow, phase, call_id, pause, source, service_name):
    """What the inspector shows. The request half is always included even when pausing on the
    response, because deciding what to send back is impossible without seeing what was asked -
    that is the whole point of pausing AFTER the supplier answered rather than before."""
    request = flow.request
    data = {
        'callId': call_id,
        'phase': phase,
        'source': source,
        'serviceName': service_name,
        'ruleId': pause.get('ruleId'),
        'ruleName': pause.get('ruleName'),
        'timeoutSeconds': pause.get('timeoutSeconds'),
        'onTimeout': pause.get('onTimeout'),
        'method': request.method,
        'url': request.pretty_url,
        'request': {
            'headers': dict(request.headers),
            'body': _text(request),
        },
    }
    if phase == 'response' and flow.response is not None:
        data['response'] = {
            'status': flow.response.status_code,
            'headers': dict(flow.response.headers),
            'body': _text(flow.response),
        }
    return data


def _text(message):
    try:
        return message.get_text(strict=False)
    except Exception:
        return None


async def wait_for_decision(flow, phase, call_id, pause, source, service_name):
    """Registers the paused flow and waits for a human, or for the timeout.

    Always returns a decision dict - never None and never raises - because every caller is on the
    request path of a real call whose client is still connected. A backend that cannot be reached
    degrades to the rule's own `onTimeout`, which is the same outcome the user would have got by
    walking away from the screen.
    """
    loop = asyncio.get_event_loop()
    deadline = loop.time() + pause['timeoutSeconds']
    timed_out = {'action': 'abort' if pause.get('onTimeout') == 'abort' else 'release',
                 'reason': 'timeout'}

    if not BACKEND:
        return timed_out

    try:
        await loop.run_in_executor(
            None, _post, '/interception/paused', snapshot(flow, phase, call_id, pause, source, service_name),
            REGISTER_TIMEOUT_SECONDS)
    except Exception as e:
        # Nobody can be shown this call, so nobody can decide on it. Releasing immediately is
        # better than holding the caller for the full timeout for a decision that cannot arrive.
        print(f"[interception] could not register paused call {call_id}: {e}")
        return {'action': timed_out['action'], 'reason': 'backend-unreachable'}

    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            window = int(min(POLL_WINDOW_SECONDS, remaining))
            if window <= 0:
                # Under a second left; one last non-blocking check rather than a pointless sleep.
                window = 1
            asked_at = loop.time()
            try:
                decision = await loop.run_in_executor(
                    None, _get, f'/interception/paused/{call_id}/decision?waitMs={window * 1000}',
                    POLL_TIMEOUT_SECONDS)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    # The backend is no longer holding this call for us - it was resolved, its own
                    # timeout fired, or the backend restarted. Either way nobody can decide on it
                    # now, so stop asking and apply the rule's fallback.
                    return {'action': timed_out['action'], 'reason': 'not-registered'}
                raise

            # Never re-ask faster than the floor, whatever came back or how quickly - see
            # MIN_POLL_INTERVAL_SECONDS. Placed before the decision checks so it costs nothing on
            # the path that actually returns.
            spent = loop.time() - asked_at
            if spent < MIN_POLL_INTERVAL_SECONDS:
                await asyncio.sleep(MIN_POLL_INTERVAL_SECONDS - spent)
            if decision and decision.get('action') == 'hold':
                # Somebody took control. The timeout was only ever a grace period for a human to
                # NOTICE the call; now that one demonstrably has, releasing it out from under them
                # mid-edit is the wrong behaviour - so the deadline moves out to the backstop and
                # this keeps polling until a real decision arrives.
                #
                # Deliberately not "wait forever": a browser tab closed on a held call would pin a
                # real client socket open with nobody left to answer it. The backend enforces the
                # same ceiling and will send a timed-out decision if it is ever reached.
                deadline = loop.time() + MAX_HELD_SECONDS
                print(f"[interception] {call_id} taken under manual control - countdown stopped")
                continue
            if decision:
                return decision
    except Exception as e:
        print(f"[interception] lost contact while waiting on {call_id}: {e}")
        return {'action': timed_out['action'], 'reason': 'backend-unreachable'}
    finally:
        # Best-effort: tell the backend this call is no longer waiting, so the inspector's queue
        # doesn't show a row whose caller has already been answered. Fire-and-forget on purpose -
        # the flow must continue whether or not this lands.
        try:
            loop.run_in_executor(None, _resolve_quietly, call_id)
        except Exception:
            pass

    return timed_out


def _resolve_quietly(call_id):
    try:
        _post(f'/interception/paused/{call_id}/resolved', {}, REGISTER_TIMEOUT_SECONDS)
    except Exception:
        pass


def report_completed(flow, call_id, outcome='completed', note=None):
    """Tells the backend a followed call's cycle is over, so its card can stop spinning.

    Fire-and-forget, and it has to stay that way: this runs after the response has already been
    handed back to the caller, so awaiting it would add a backend round trip to the tail of a call
    that is otherwise finished. A card left spinning because the backend was slow is a far smaller
    problem than a caller waiting on Alfred's bookkeeping.

    Only called for a call somebody actually decided on - the backend ignores an id it is not
    holding a card for, which is every call in normal traffic.
    """
    payload = {'outcome': outcome}
    if note:
        payload['note'] = note
    if flow is not None and flow.response is not None:
        payload['response'] = {
            'status': flow.response.status_code,
            'headers': dict(flow.response.headers),
            'body': _text(flow.response),
        }
    try:
        asyncio.get_event_loop().run_in_executor(
            None, _report_quietly, call_id, payload)
    except Exception:
        pass


def _report_quietly(call_id, payload):
    try:
        _post(f'/interception/paused/{call_id}/completed', payload, REGISTER_TIMEOUT_SECONDS)
    except Exception:
        pass
