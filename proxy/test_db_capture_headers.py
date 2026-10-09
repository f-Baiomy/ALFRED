"""
Tests for database capture's two headers (specs/006-db-capture/contracts/proxy-headers.md):

- the reverse proxy stamps X-Alfred-Call (call id, db switch, Relive run tag) on a logged inbound request and
  removes any copy a client sent;
- the forward proxy pops X-Alfred-Parent (set by the db-agent on the app's supplier calls) and records the
  parent call id and order instead of forwarding the header.

Reuses test_interception.py's fake flows, like test_relive.py.

    python -m pytest test_db_capture_headers.py -q
"""

import os
import tempfile
import unittest
from unittest.mock import patch

import log_and_route
import log_and_route_reverse
import relive
from test_interception import FakeFlow, FakeRequest, run


class FakeVerdict:
    terminal = None

    def as_log(self):
        return None


async def no_relive_inbound(flow, name, addresses, engine):
    return None, None


async def no_relive_outbound(flow, service_name, addresses, engine):
    return None, None


async def plain_verdict(flow, name):
    return FakeVerdict()


async def nothing(*args, **kwargs):
    return None


def write_flag(tmp, name, lines):
    path = os.path.join(tmp, name)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(''.join(line + '\n' for line in lines))
    return path


class ReverseProxyStampsAlfredCall(unittest.TestCase):

    def _forward(self, flow, logging_on=True, db_flag_lines=None, relive_info=None, db_flag_missing=False, log_flag_lines=None,
                 redis_flag_lines=None):
        sent = []

        async def inbound(flow, name, addresses, engine):
            return None, relive_info

        addon = log_and_route_reverse.RouteAndLog()
        with tempfile.TemporaryDirectory() as tmp:
            db_flag = os.path.join(tmp, 'absent.flag') if db_flag_missing else write_flag(tmp, 'db.flag', db_flag_lines or [])
            log_flag = write_flag(tmp, 'log.flag', log_flag_lines) if log_flag_lines is not None else os.path.join(tmp, 'absent-log.flag')
            redis_flag = write_flag(tmp, 'redis.flag', redis_flag_lines) if redis_flag_lines is not None else os.path.join(tmp, 'absent-redis.flag')
            # A fresh reader per test: _ToggleState caches by mtime, and two files written in the same second
            # by consecutive tests could share one.
            with patch.object(log_and_route_reverse, 'WEBHOOK_URL', 'http://backend/webhook'), \
                    patch.object(log_and_route_reverse, 'DB_CAPTURE_TOGGLE_FILE', db_flag), \
                    patch.object(log_and_route_reverse, '_db_capture', log_and_route_reverse._ToggleState('DB_CAPTURE_TOGGLE_FILE', default=False)), \
                    patch.object(log_and_route_reverse, 'LOG_LINK_TOGGLE_FILE', log_flag), \
                    patch.object(log_and_route_reverse, '_log_link', log_and_route_reverse._ToggleState('LOG_LINK_TOGGLE_FILE', default=False)), \
                    patch.object(log_and_route_reverse, 'REDIS_CAPTURE_TOGGLE_FILE', redis_flag), \
                    patch.object(log_and_route_reverse, '_redis_capture', log_and_route_reverse._ToggleState('REDIS_CAPTURE_TOGGLE_FILE', default=False)), \
                    patch.object(log_and_route_reverse._toggle, 'enabled', lambda name: logging_on), \
                    patch.object(relive, 'apply_inbound', inbound), \
                    patch.object(log_and_route_reverse.ENGINE, 'apply_request', plain_verdict), \
                    patch.object(log_and_route_reverse, '_send_webhook', lambda *a: sent.append(a)), \
                    patch.object(log_and_route_reverse._webhook_queue, 'put_nowait', lambda item: sent.append(item)), \
                    patch.object(log_and_route_reverse, 'PORT_MAP', {0: ('wallet-app', 8081)}), \
                    patch.object(addon, '_carry_out', nothing), \
                    patch.object(addon, '_listen_port', lambda flow: 0):
                run(addon.request(flow))
        return sent

    def test_db_on_stamps_call_id_and_db_1(self):
        flow = FakeFlow(request=FakeRequest(method='POST', host='localhost', path='/pay'))
        sent = self._forward(flow, db_flag_lines=['wallet-app=on'])
        call_id = flow.metadata['call_id']
        self.assertEqual(f'id={call_id}; db=1', flow.request.headers.get('X-Alfred-Call'))
        # The recorded request is what the client sent - the header is ALFRED's own plumbing.
        logged = sent[0][2]
        self.assertNotIn('X-Alfred-Call', logged['request']['headers'])

    def test_missing_line_and_missing_file_mean_off(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_lines=['other-app=on'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=0'))

        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_missing=True)
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=0'))

    def test_explicit_off_line(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_lines=['wallet-app=off'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=0'))

    def test_relive_step_adds_the_run_tag(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_lines=['wallet-app=on'],
                      relive_info={'runId': 'run-a', 'stepKey': 's-pay', 'attribution': 'HEADER'})
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=1; run=run-a/s-pay'))

    def test_logs_switch_adds_log_1_with_or_without_db_capture(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_lines=['wallet-app=on'], log_flag_lines=['wallet-app=on'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=1; log=1'))

        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, log_flag_lines=['wallet-app=on'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=0; log=1'))

    def test_logs_switch_off_missing_line_or_missing_file_adds_nothing(self):
        for lines in (['wallet-app=off'], ['other-app=on'], None):
            flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
            self._forward(flow, log_flag_lines=lines)
            self.assertNotIn('log=1', flow.request.headers.get('X-Alfred-Call'))

    def test_redis_switch_adds_redis_1_with_or_without_db_capture(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, db_flag_lines=['wallet-app=on'], redis_flag_lines=['wallet-app=on'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=1; redis=1'))

        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, redis_flag_lines=['wallet-app=on'], log_flag_lines=['wallet-app=on'])
        self.assertTrue(flow.request.headers.get('X-Alfred-Call').endswith('; db=0; log=1; redis=1'))

    def test_redis_switch_off_missing_line_or_missing_file_adds_nothing(self):
        for lines in (['wallet-app=off'], ['other-app=on'], None):
            flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
            self._forward(flow, redis_flag_lines=lines)
            self.assertNotIn('redis=1', flow.request.headers.get('X-Alfred-Call'))

    def test_logging_off_adds_no_header_even_with_the_redis_switch_on(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, logging_on=False, redis_flag_lines=['wallet-app=on'])
        self.assertIsNone(flow.request.headers.get('X-Alfred-Call'))

    def test_logging_off_adds_no_header_even_with_the_logs_switch_on(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, logging_on=False, log_flag_lines=['wallet-app=on'])
        self.assertIsNone(flow.request.headers.get('X-Alfred-Call'))

    def test_logging_off_adds_no_header(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        self._forward(flow, logging_on=False, db_flag_lines=['wallet-app=on'])
        self.assertIsNone(flow.request.headers.get('X-Alfred-Call'))

    def test_client_sent_header_is_removed_even_when_logging_is_off(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x',
                                            headers={'X-Alfred-Call': 'id=someone-else; db=1'}))
        self._forward(flow, logging_on=False, db_flag_lines=['wallet-app=on'])
        self.assertIsNone(flow.request.headers.get('X-Alfred-Call'))

        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x',
                                            headers={'x-alfred-call': 'id=someone-else; db=1'}))
        self._forward(flow, db_flag_lines=['wallet-app=on'])
        self.assertNotIn('someone-else', flow.request.headers.get('X-Alfred-Call'))


class ReverseProxyCompletionNamesItsCall(unittest.TestCase):
    """A prepare that timed out may reach the backend after the completion, or never: the completion carries the
    call's URL, method, time and project so it is never stored as a bare response (one failed every log search)."""

    def test_the_completion_carries_what_the_prepare_said_about_the_call_but_no_headers_or_body(self):
        flow = FakeFlow(request=FakeRequest(method='OPTIONS', host='localhost', path='/odeysysadmin/Admin2/userDetails',
                                            headers={'Origin': 'http://localhost:8500'}))
        sent = ReverseProxyStampsAlfredCall._forward(self, flow)
        prepare = next(item for item in sent if item[0] == 'prepare')[2]
        written = []
        addon = log_and_route_reverse.RouteAndLog()
        with patch.object(log_and_route_reverse._webhook_queue, 'put_nowait', lambda item: written.append(item)):
            addon._write(flow, prepare['id'], {'response': {'status': 200}, 'duration_ms': 29.9})
        phase, call_id, data = written[0]
        self.assertEqual(('complete', prepare['id']), (phase, call_id))
        self.assertEqual({key: prepare[key] for key in ('original_url', 'url', 'method', 'timestamp', 'service_name',
                                                        'session_id', 'operation_id')}, data['call'])
        self.assertEqual('OPTIONS', data['call']['method'])
        self.assertNotIn('request', data['call'])
        self.assertEqual(200, data['response']['status'])

    def test_a_flow_that_was_never_logged_adds_nothing(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        written = []
        with patch.object(log_and_route_reverse._webhook_queue, 'put_nowait', lambda item: written.append(item)):
            log_and_route_reverse.RouteAndLog()._write(flow, 'c1', {'error': 'boom'})
        self.assertNotIn('call', written[0][2])


class ReverseProxyTellsTheAgentWhereAlfredIs(unittest.TestCase):
    """alfred= and key= in X-Alfred-Call: the agent follows the proxy that delivers its calls, whatever its own
    arguments say (a stale -javaagent pointing at a port nothing listens on, a Docker install that is gone)."""

    def test_agent_url_and_key_are_stamped_when_the_proxy_knows_them(self):
        value = log_and_route_reverse.alfred_call_header('c1', True, None, log_on=True, agent_url='http://127.0.0.1:3001',
                                                         key='1759860000.abc')
        self.assertEqual('id=c1; db=1; log=1; alfred=http://127.0.0.1:3001; key=1759860000.abc', value)

    def test_nothing_is_stamped_without_an_agent_url(self):
        self.assertEqual('id=c1; db=0', log_and_route_reverse.alfred_call_header('c1', False, None, agent_url='', key='x'))
        self.assertEqual('id=c1; db=0; alfred=http://h:1',
                         log_and_route_reverse.alfred_call_header('c1', False, None, agent_url='http://h:1', key=None))

    def test_key_is_an_hourly_hmac_of_the_secret_and_never_the_secret(self):
        a = log_and_route_reverse.agent_key('s3cret', now=1759860000)
        b = log_and_route_reverse.agent_key('s3cret', now=1759860000 + 1799)
        c = log_and_route_reverse.agent_key('s3cret', now=1759860000 + 3600)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        issued, digest = a.split('.')
        self.assertEqual('1759860000', issued)
        self.assertEqual(64, len(digest))
        self.assertNotIn('s3cret', a)
        self.assertNotEqual(a, log_and_route_reverse.agent_key('other', now=1759860000))
        self.assertIsNone(log_and_route_reverse.agent_key('', now=1759860000))

    def test_the_forwarded_request_carries_them(self):
        flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
        with patch.object(log_and_route_reverse, 'AGENT_URL', 'http://127.0.0.1:3001'),                 patch.object(log_and_route_reverse, 'WEBHOOK_SECRET', 's3cret'):
            ReverseProxyStampsAlfredCall._forward(self, flow)
        header = flow.request.headers.get('X-Alfred-Call')
        self.assertIn('; alfred=http://127.0.0.1:3001; key=', header)
        self.assertNotIn('s3cret', header)


class AlfredCallHeaderValue(unittest.TestCase):

    def test_formats(self):
        self.assertEqual('id=c1; db=0', log_and_route_reverse.alfred_call_header('c1', False, None))
        self.assertEqual('id=c1; db=1', log_and_route_reverse.alfred_call_header('c1', True, {'runId': None}))
        self.assertEqual('id=c1; db=1; run=r/s', log_and_route_reverse.alfred_call_header('c1', True, {'runId': 'r', 'stepKey': 's'}))
        self.assertEqual('id=c1; db=0; log=1', log_and_route_reverse.alfred_call_header('c1', False, None, True))
        self.assertEqual('id=c1; db=1; log=1; run=r/s', log_and_route_reverse.alfred_call_header('c1', True, {'runId': 'r', 'stepKey': 's'}, True))
        self.assertEqual('id=c1; db=0; redis=1', log_and_route_reverse.alfred_call_header('c1', False, None, False, True))
        self.assertEqual('id=c1; db=1; log=1; redis=1; run=r/s',
                         log_and_route_reverse.alfred_call_header('c1', True, {'runId': 'r', 'stepKey': 's'}, True, True))


class ForwardProxyPopsAlfredParent(unittest.TestCase):

    def test_take_parent_header(self):
        flow = FakeFlow(request=FakeRequest(headers={'X-Alfred-Parent': '7c1e09a2-aa; seq=18'}))
        self.assertEqual(('7c1e09a2-aa', 18), log_and_route.take_parent_header(flow))
        self.assertIsNone(flow.request.headers.get('X-Alfred-Parent'))

    def test_malformed_is_removed_and_ignored(self):
        for raw in ('', 'abc', 'abc; seq=x', '; seq=3', 'abc; seq=-1'):
            flow = FakeFlow(request=FakeRequest(headers={'X-Alfred-Parent': raw}))
            self.assertEqual((None, None), log_and_route.take_parent_header(flow), raw)
            self.assertIsNone(flow.request.headers.get('X-Alfred-Parent'), raw)

    def test_absent(self):
        flow = FakeFlow(request=FakeRequest())
        self.assertEqual((None, None), log_and_route.take_parent_header(flow))

    def test_request_logs_parent_and_never_forwards_the_header(self):
        sent = []
        addon = log_and_route.RouteAndLog()
        flow = FakeFlow(request=FakeRequest(method='POST', host='pay.supplier.com', path='/v1/charge',
                                            headers={'X-Alfred-Parent': 'call-1; seq=7'}))
        with patch.object(log_and_route, 'WEBHOOK_URL', 'http://backend/webhook'), \
                patch.object(relive, 'apply_outbound', no_relive_outbound), \
                patch.object(log_and_route.ENGINE, 'apply_request', plain_verdict), \
                patch.object(log_and_route._webhook_queue, 'put_nowait', lambda item: sent.append(item)), \
                patch.object(addon, '_carry_out', nothing), \
                patch.object(addon, '_attributed_service', lambda flow: None):
            run(addon.request(flow))
        self.assertIsNone(flow.request.headers.get('X-Alfred-Parent'))
        logged = sent[0][2]
        self.assertEqual('call-1', logged['parent_call_id'])
        self.assertEqual(7, logged['parent_seq'])
        self.assertNotIn('X-Alfred-Parent', logged['request']['headers'])


if __name__ == '__main__':
    unittest.main()
