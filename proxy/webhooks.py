"""
Delivers the proxies' call reports (webhooks) to backend - shared by log_and_route.py (outbound) and
log_and_route_reverse.py (inbound), the same way interception.py and relive.py are.

Each call is reported twice: "prepare" when the request arrives and "complete" when it settles (plus "ws-messages"
batches). They are sent from one background worker thread per addon, in order, so a slow backend delays the reports
but never the proxied traffic.

Until 2026-10-09 every report gave up after 2 s and was never retried. The backend stalls longer than that - a long
GC pause with 7,000 inbound calls held in memory, a 467 MB file rewrite taking 6.7 s on the Docker Desktop mount, a
restart - and a lost prepare left a call stored as a bare response with no URL, method or time (one such row failed
every log search). Now each attempt waits WEBHOOK_TIMEOUT_SECONDS (15 s by default) and a failure that a later
attempt can fix is retried after 2, 5 and 10 s. A definite answer (any 4xx: wrong secret, unknown call, bad payload)
is not retried - asking again cannot change it.

Every failure is printed with flush=True: under Docker stdout is a pipe and Python block-buffers it, which is why the
failures of 2026-10-09 only appeared when the container restarted, half an hour later. A line names the call, the
report and the reason - never a body, a header or the secret.
"""

import json
import time
import urllib.error
import urllib.request

# Waits before the 2nd, 3rd and 4th attempt.
RETRY_DELAYS = (2, 5, 10)

OK = 'ok'
RETRYABLE = 'retryable'
FINAL = 'final'


def endpoint(base_url, phase, call_id):
    if phase == 'prepare':
        return f'{base_url}/prepare'
    if phase == 'ws-messages':
        return f'{base_url}/{call_id}/ws-messages'
    return f'{base_url}/{call_id}/complete'


def attempt(url, secret, data, timeout):
    """One POST. Returns (OK | RETRYABLE | FINAL, reason)."""
    request = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'X-Webhook-Secret': secret},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout):
            return OK, None
    except urllib.error.HTTPError as e:
        reason = f'HTTP {e.code} {e.reason}'.strip()
        return (RETRYABLE if e.code >= 500 else FINAL), reason
    except Exception as e:  # timeout, refused, reset, DNS - the backend may answer next time
        text = str(getattr(e, 'reason', '') or e)
        if isinstance(e, TimeoutError) or 'timed out' in text:
            return RETRYABLE, 'timed out'
        return RETRYABLE, f'{type(e).__name__}: {text}'


def send(base_url, secret, phase, call_id, data, timeout, retries=True, sleep=None):
    """Delivers one report, retrying a retryable failure unless retries=False. Returns OK, RETRYABLE (gave up while
    the backend may still take it later) or FINAL. Blocks - call it from a worker thread, never from a mitmproxy hook
    on the event loop (a sync sleep there freezes every connection the proxy carries)."""
    url = endpoint(base_url, phase, call_id)
    attempts = 1 + (len(RETRY_DELAYS) if retries else 0)
    for n in range(1, attempts + 1):
        outcome, reason = attempt(url, secret, data, timeout)
        if outcome == OK:
            return OK
        if outcome == FINAL:
            print(f'[webhook] {phase} failed for {call_id}: {reason} (not retried)', flush=True)
            return FINAL
        print(f'[webhook] {phase} attempt {n}/{attempts} failed for {call_id}: {reason}', flush=True)
        if n < attempts:
            (sleep or time.sleep)(RETRY_DELAYS[n - 1])
    if retries:
        print(f'[webhook] {phase} given up for {call_id} after {attempts} attempts', flush=True)
    return RETRYABLE
