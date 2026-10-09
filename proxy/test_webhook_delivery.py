"""
Report delivery (webhooks.py) and how both addons use it - specs/013-inbound-calls-store, contracts/webhooks.md.

On 2026-10-09 a backend stall longer than the old 2 s timeout lost an inbound call's prepare: the call was stored as a
bare response and one such row failed every log search. The failure line only appeared half an hour later, at the
container restart, because stdout was block-buffered.

    python -m pytest test_webhook_delivery.py -q
"""

import io
import json
import queue
import socket
import threading
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest.mock import patch

import log_and_route
import log_and_route_reverse
import relive
import webhooks
from test_db_capture_headers import FakeVerdict, nothing, plain_verdict
from test_interception import FakeFlow, FakeRequest, run


class _Ok:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(code, reason):
    return urllib.error.HTTPError('http://backend', code, reason, {}, None)


class Backend:
    """Stands in for urlopen: answers each POST from a script of outcomes (an exception or 'ok'), recording urls."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.urls = []
        self.bodies = []

    def __call__(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.bodies.append(json.loads(request.data.decode('utf-8')))
        self.timeout = timeout
        outcome = self.outcomes.pop(0) if self.outcomes else 'ok'
        if outcome == 'ok':
            return _Ok()
        raise outcome


def deliver(backend, phase='prepare', retries=True, data=None):
    waits = []
    out = io.StringIO()
    with patch('urllib.request.urlopen', backend), redirect_stdout(out):
        result = webhooks.send('http://backend/internal-calls/webhook', 's3cret', phase, 'call-1',
                               data if data is not None else {'id': 'call-1'}, 15, retries=retries, sleep=waits.append)
    return result, waits, out.getvalue()


class Retry(unittest.TestCase):

    def test_a_timeout_is_retried_and_delivered_on_the_second_attempt(self):
        result, waits, out = deliver(Backend(socket.timeout('timed out'), 'ok'))
        self.assertEqual(webhooks.OK, result)
        self.assertEqual([2], waits)
        self.assertIn('[webhook] prepare attempt 1/4 failed for call-1: timed out', out)

    def test_four_failures_give_up_after_waiting_2_5_and_10_seconds(self):
        backend = Backend(*[urllib.error.URLError(ConnectionRefusedError('refused'))] * 4)
        result, waits, out = deliver(backend)
        self.assertEqual(webhooks.RETRYABLE, result)
        self.assertEqual([2, 5, 10], waits)
        self.assertEqual(4, len(backend.urls))
        self.assertIn('[webhook] prepare given up for call-1 after 4 attempts', out)

    def test_a_5xx_is_retried(self):
        result, waits, _ = deliver(Backend(http_error(503, 'Service Unavailable'), 'ok'), phase='complete')
        self.assertEqual(webhooks.OK, result)
        self.assertEqual([2], waits)

    def test_a_4xx_is_a_definite_answer_and_is_not_retried(self):
        for code, reason in ((404, 'Not Found'), (401, 'Unauthorized'), (400, 'Bad Request')):
            backend = Backend(http_error(code, reason))
            result, waits, out = deliver(backend, phase='complete')
            self.assertEqual(webhooks.FINAL, result)
            self.assertEqual([], waits)
            self.assertEqual(1, len(backend.urls))
            self.assertIn(f'[webhook] complete failed for call-1: HTTP {code} {reason} (not retried)', out)

    def test_without_retries_one_attempt_only(self):
        backend = Backend(socket.timeout('timed out'))
        result, waits, out = deliver(backend, retries=False)
        self.assertEqual(webhooks.RETRYABLE, result)
        self.assertEqual([], waits)
        self.assertIn('attempt 1/1 failed', out)
        self.assertNotIn('given up', out)

    def test_endpoints(self):
        self.assertEqual('http://b/prepare', webhooks.endpoint('http://b', 'prepare', 'c'))
        self.assertEqual('http://b/c/complete', webhooks.endpoint('http://b', 'complete', 'c'))
        self.assertEqual('http://b/c/ws-messages', webhooks.endpoint('http://b', 'ws-messages', 'c'))


class FailureLines(unittest.TestCase):

    def test_lines_are_flushed_and_never_carry_a_body_a_header_or_the_secret(self):
        flushed = []
        real_print = print

        def spy(*args, **kwargs):
            flushed.append(kwargs.get('flush'))
            real_print(*args, **kwargs)

        data = {'id': 'call-1', 'request': {'headers': {'Authorization': 'Bearer top-secret-token'},
                                            'body': 'card=4111111111111111'}}
        with patch('builtins.print', spy):
            _, _, out = deliver(Backend(*[socket.timeout('timed out')] * 4), data=data)
        self.assertTrue(flushed and all(flushed))
        for secret in ('s3cret', 'top-secret-token', '4111111111111111', 'Authorization'):
            self.assertNotIn(secret, out)


class BothAddonsUseIt(unittest.TestCase):

    def test_defaults_wait_15_seconds(self):
        for module in (log_and_route, log_and_route_reverse):
            self.assertEqual(15.0, module.WEBHOOK_TIMEOUT_SECONDS, module.__name__)
            self.assertEqual(15.0, module.PREPARE_TIMEOUT_SECONDS, module.__name__)

    def test_reverse_send_goes_through_webhooks_with_its_timeout(self):
        calls = []
        with patch.object(log_and_route_reverse, 'WEBHOOK_URL', 'http://backend/internal-calls/webhook'), \
                patch.object(webhooks, 'send', lambda *a, **k: calls.append((a, k)) or webhooks.OK):
            log_and_route_reverse._send_webhook('prepare', 'c1', {'id': 'c1'})
        args, kwargs = calls[0]
        self.assertEqual(('http://backend/internal-calls/webhook', log_and_route_reverse.WEBHOOK_SECRET, 'prepare', 'c1',
                          {'id': 'c1'}, 15.0), args)
        self.assertTrue(kwargs.get('retries', True))

    def test_a_prepare_that_keeps_failing_is_still_sent_before_its_complete(self):
        # One worker, FIFO: the prepare's retries finish (or give up) before the complete is attempted.
        for module, base in ((log_and_route_reverse, 'http://backend/internal-calls/webhook'),
                             (log_and_route, 'http://backend/calls/webhook')):
            backend = Backend(socket.timeout('timed out'), socket.timeout('timed out'), 'ok', 'ok')
            q = queue.Queue()
            q.put(('prepare', 'c1', {'id': 'c1'}))
            q.put(('complete', 'c1', {'response': {'status': 200}}))
            q.put(None)
            with patch('urllib.request.urlopen', backend), patch.object(module, 'WEBHOOK_URL', base), \
                    patch.object(module, '_webhook_queue', q), patch('time.sleep', lambda s: None), \
                    redirect_stdout(io.StringIO()):
                worker = threading.Thread(target=module._webhook_worker, daemon=True)
                worker.start()
                worker.join(5)
            self.assertEqual([f'{base}/prepare'] * 3 + [f'{base}/c1/complete'], backend.urls, module.__name__)


class ReliveSynchronousPrepare(unittest.TestCase):
    """A Relive step's prepare is sent on the request path (the app may call a supplier at once). It is tried once
    there - a retry would hold the request - and a failure hands it to the worker queue for its retries."""

    def _request(self, outcome):
        queued, sent = [], []

        async def inbound(flow, name, addresses, engine):
            return None, {'runId': 'r1', 'stepKey': 's1', 'cycleId': 'c'}

        def fake_send(phase, call_id, data, retries=True):
            sent.append((phase, retries))
            return outcome

        addon = log_and_route_reverse.RouteAndLog()
        flow = FakeFlow(request=FakeRequest(method='POST', host='localhost', path='/pay'))
        with patch.object(log_and_route_reverse, 'WEBHOOK_URL', 'http://backend/webhook'), \
                patch.object(log_and_route_reverse._toggle, 'enabled', lambda name: True), \
                patch.object(relive, 'apply_inbound', inbound), \
                patch.object(log_and_route_reverse.ENGINE, 'apply_request', plain_verdict), \
                patch.object(log_and_route_reverse, '_send_webhook', fake_send), \
                patch.object(log_and_route_reverse._webhook_queue, 'put_nowait', queued.append), \
                patch.object(log_and_route_reverse, 'PORT_MAP', {0: ('wallet-app', 8081)}), \
                patch.object(addon, '_carry_out', nothing), \
                patch.object(addon, '_listen_port', lambda flow: 0):
            run(addon.request(flow))
        return sent, queued

    def test_tried_once_on_the_request_path_and_queued_for_retries_when_it_fails(self):
        sent, queued = self._request(webhooks.RETRYABLE)
        self.assertEqual([('prepare', False)], sent)
        self.assertEqual(['prepare'], [item[0] for item in queued])

    def test_not_queued_again_once_delivered_or_definitely_refused(self):
        for outcome in (webhooks.OK, webhooks.FINAL):
            sent, queued = self._request(outcome)
            self.assertEqual([('prepare', False)], sent)
            self.assertEqual([], queued)


if __name__ == '__main__':
    unittest.main()
