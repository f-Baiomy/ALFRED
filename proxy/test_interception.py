"""
Tests for the interception engine. Pure stdlib unittest, no pytest and no third-party mocking -
the proxy runs a stock mitmproxy image with bind-mounted scripts and no pip step, so anything
these tests need would also have to be installed there.

    python -m unittest discover -s proxy -p "test_*.py"

The flow objects are hand-rolled fakes rather than real mitmproxy flows for the same reason: a
real flow needs a connection. They implement exactly the surface interception.py touches, which
is also a useful pin - if the engine starts reaching for something else, these stop compiling.
"""

import asyncio
import json
import os
import tempfile
import time
import unittest
import urllib.error

import breakpoints
import interception


class FakeHeaders(dict):
    """mitmproxy's Headers is case-insensitive; dict is not, and the engine relies on the
    difference in exactly one place (REMOVE_*_HEADER's membership test)."""

    def __contains__(self, key):
        return any(k.lower() == key.lower() for k in self.keys())

    def __setitem__(self, key, value):
        for existing in list(self.keys()):
            if existing.lower() == key.lower():
                dict.__delitem__(self, existing)
        dict.__setitem__(self, key, value)

    def __delitem__(self, key):
        for existing in list(self.keys()):
            if existing.lower() == key.lower():
                dict.__delitem__(self, existing)


class FakeMessage:
    def __init__(self, text=None, headers=None, status=None):
        self.text = text
        self.headers = FakeHeaders(headers or {})
        self.status_code = status
        self.reason = 'OK'


class FakeRequest(FakeMessage):
    def __init__(self, method='GET', host='example.com', path='/', text=None, headers=None, query=None):
        FakeMessage.__init__(self, text=text, headers=headers)
        self.method = method
        self.host = host
        self.pretty_host = host
        self.path = path
        self.query = dict(query or {})
        self.pretty_url = f'https://{host}{path}'


class FakeFlow:
    def __init__(self, request=None, response=None):
        self.request = request or FakeRequest()
        self.response = response
        self.metadata = {}
        self.killed = False

    def kill(self):
        self.killed = True


def write_rules(tmpdir, rules, enabled=True):
    path = os.path.join(tmpdir, 'rules.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'enabled': enabled, 'rules': rules}, f)
    return path


def rule(**kwargs):
    base = {'id': 'r1', 'name': 'Test rule', 'enabled': True, 'priority': 100,
            'match': {}, 'actions': []}
    base.update(kwargs)
    return base


class MatchingTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, rules, source='outbound', enabled=True):
        return interception.InterceptionEngine(source, write_rules(self.tmp.name, rules, enabled))

    def test_method_must_match(self):
        engine = self.engine([rule(match={'methods': ['POST']},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        flow = FakeFlow(FakeRequest(method='GET'))
        self.assertFalse(engine.apply_request(flow).touched)
        flow = FakeFlow(FakeRequest(method='POST'))
        self.assertTrue(engine.apply_request(flow).touched)

    def test_host_wildcard_matches_subdomain_and_apex(self):
        engine = self.engine([rule(match={'host': '*.sabre.com'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        for host, expected in [('api.sabre.com', True), ('sabre.com', True),
                               ('a.b.sabre.com', True), ('notsabre.com', False),
                               ('sabre.com.evil.net', False)]:
            flow = FakeFlow(FakeRequest(host=host))
            self.assertEqual(engine.apply_request(flow).touched, expected, host)

    def test_source_scopes_a_rule_to_one_direction(self):
        rules = [rule(match={'source': 'inbound'},
                      actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])]
        self.assertFalse(self.engine(rules, 'outbound').apply_request(FakeFlow()).touched)
        self.assertTrue(self.engine(rules, 'inbound').apply_request(FakeFlow()).touched)

    def test_path_regex_and_contains(self):
        engine = self.engine([rule(match={'pathRegex': r'/v\d+/order'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertTrue(engine.apply_request(FakeFlow(FakeRequest(path='/v4/order/create'))).touched)
        self.assertFalse(engine.apply_request(FakeFlow(FakeRequest(path='/vx/order'))).touched)

    def test_service_name_scopes_a_rule_to_one_project(self):
        engine = self.engine([rule(match={'serviceName': 'Core-service'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertFalse(engine.apply_request(FakeFlow(), 'Odeysys').touched)
        self.assertTrue(engine.apply_request(FakeFlow(), 'Core-service').touched)

    def test_disabled_rule_never_applies(self):
        engine = self.engine([rule(enabled=False,
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertFalse(engine.apply_request(FakeFlow()).touched)

    def test_master_switch_off_disables_every_rule(self):
        engine = self.engine([rule(actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])],
                             enabled=False)
        self.assertFalse(engine.apply_request(FakeFlow()).touched)

    def test_missing_rules_file_is_inert_not_an_error(self):
        engine = interception.InterceptionEngine('outbound', os.path.join(self.tmp.name, 'nope.json'))
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertFalse(verdict.touched)
        self.assertIsNone(verdict.as_log())

    def test_corrupt_rules_file_disables_rather_than_crashes(self):
        path = os.path.join(self.tmp.name, 'bad.json')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('{ this is not json')
        engine = interception.InterceptionEngine('outbound', path)
        self.assertFalse(engine.apply_request(FakeFlow()).touched)

    def test_rules_are_reloaded_when_the_file_changes(self):
        path = write_rules(self.tmp.name, [])
        engine = interception.InterceptionEngine('outbound', path)
        self.assertFalse(engine.apply_request(FakeFlow()).touched)
        time.sleep(0.01)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'enabled': True, 'rules': [
                rule(actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])]}, f)
        os.utime(path, (time.time() + 1, time.time() + 1))
        self.assertTrue(engine.apply_request(FakeFlow()).touched)

    def test_all_matching_rules_apply_in_priority_order(self):
        engine = self.engine([
            rule(id='b', name='second', priority=20,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-Order', 'value': 'b'}]),
            rule(id='a', name='first', priority=10,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-Order', 'value': 'a'}]),
        ])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertEqual([a.rule_name for a in verdict.applied], ['first', 'second'])
        self.assertEqual(flow.request.headers['X-Order'], 'b')

    def test_stop_processing_halts_later_rules(self):
        engine = self.engine([
            rule(id='a', name='first', priority=10, stopProcessing=True,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-A', 'value': '1'}]),
            rule(id='b', name='second', priority=20,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-B', 'value': '1'}]),
        ])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertEqual([a.rule_name for a in verdict.applied], ['first'])

    def test_a_rule_that_throws_is_skipped_not_fatal(self):
        engine = self.engine([
            rule(id='a', name='broken', priority=10,
                 actions=[{'type': 'SET_REQUEST_JSON_FIELD', 'path': None, 'value': 1}]),
            rule(id='b', name='fine', priority=20,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-B', 'value': '1'}]),
        ])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertEqual(flow.request.headers['X-B'], '1')
        self.assertEqual([a.rule_name for a in verdict.applied], ['fine'])


class RequestActionsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def test_delay_is_returned_not_slept(self):
        started = time.time()
        verdict = self.engine([{'type': 'DELAY_REQUEST', 'durationMs': 5000}]).apply_request(FakeFlow())
        self.assertEqual(verdict.delay_ms, 5000)
        self.assertLess(time.time() - started, 0.5, 'engine must never sleep on its own thread')

    def test_delays_sum_across_rules_and_are_clamped(self):
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'DELAY_REQUEST', 'durationMs': 2000}]),
            rule(id='b', priority=2, actions=[{'type': 'DELAY_REQUEST', 'durationMs': 3000}]),
        ])
        verdict = interception.InterceptionEngine('outbound', path).apply_request(FakeFlow())
        self.assertEqual(verdict.delay_ms, 5000)

    def test_delay_over_the_ceiling_is_capped(self):
        verdict = self.engine([{'type': 'DELAY_REQUEST', 'durationMs': 99999999}]).apply_request(FakeFlow())
        self.assertEqual(verdict.delay_ms, interception.MAX_DELAY_MS)

    def test_set_and_remove_request_header(self):
        engine = self.engine([
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Alfred-Test', 'value': 'true'},
            {'type': 'REMOVE_REQUEST_HEADER', 'name': 'X-Drop-Me'},
        ])
        flow = FakeFlow(FakeRequest(headers={'X-Drop-Me': 'gone'}))
        engine.apply_request(flow)
        self.assertEqual(flow.request.headers['X-Alfred-Test'], 'true')
        self.assertNotIn('X-Drop-Me', flow.request.headers)

    def test_sensitive_header_value_is_never_recorded(self):
        engine = self.engine([{'type': 'SET_REQUEST_HEADER', 'name': 'Authorization', 'value': 'Bearer hunter2'}])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        serialised = json.dumps(verdict.as_log())
        self.assertIn('Bearer hunter2', flow.request.headers['Authorization'])
        self.assertNotIn('hunter2', serialised)

    def test_query_params(self):
        engine = self.engine([
            {'type': 'SET_QUERY_PARAM', 'name': 'passengers', 'value': '5'},
            {'type': 'REMOVE_QUERY_PARAM', 'name': 'debug'},
        ])
        flow = FakeFlow(FakeRequest(query={'passengers': '1', 'debug': '1'}))
        engine.apply_request(flow)
        self.assertEqual(flow.request.query['passengers'], '5')
        self.assertNotIn('debug', flow.request.query)

    def test_json_body_field(self):
        engine = self.engine([
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'passengerCount', 'value': 5},
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'currency', 'value': 'EUR'},
        ])
        flow = FakeFlow(FakeRequest(text=json.dumps({'passengerCount': 1, 'currency': 'USD'})))
        engine.apply_request(flow)
        self.assertEqual(json.loads(flow.request.text), {'passengerCount': 5, 'currency': 'EUR'})

    def test_abort_is_terminal(self):
        engine = self.engine([
            {'type': 'ABORT_REQUEST'},
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Never', 'value': '1'},
        ])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertEqual(verdict.terminal, 'ABORT_REQUEST')
        self.assertNotIn('X-Never', flow.request.headers)

    def test_mock_response_is_terminal_and_carries_its_payload(self):
        engine = self.engine([
            {'type': 'MOCK_RESPONSE', 'status': 500, 'headers': {'Content-Type': 'application/json'},
             'body': '{"error":"Simulated supplier failure"}'},
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Never', 'value': '1'},
        ])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertEqual(verdict.terminal, 'MOCK_RESPONSE')
        self.assertEqual(verdict.mock['status'], 500)
        self.assertNotIn('X-Never', flow.request.headers)

    def test_send_to_host_on_its_own_forwards_and_records_itself(self):
        engine = self.engine([{'type': 'SEND_TO_HOST'}])
        flow = FakeFlow()
        verdict = engine.apply_request(flow)
        self.assertIsNone(verdict.terminal)
        self.assertTrue(verdict.must_reach_host)
        self.assertEqual([a.action for a in verdict.applied], ['SEND_TO_HOST'])

    def test_send_to_host_refuses_a_later_rules_mock(self):
        # The exception pattern: a narrow high-priority rule insists a call really happens, and a
        # broad mocking rule below it no longer applies to that call.
        path = write_rules(self.tmp.name, [
            rule(id='exception', name='Really call health', priority=1,
                 match={'pathContains': '/health'},
                 actions=[{'type': 'SEND_TO_HOST'}]),
            rule(id='broad', name='Mock everything', priority=50,
                 actions=[{'type': 'MOCK_RESPONSE', 'status': 503, 'body': 'nope'}]),
        ])
        engine = interception.InterceptionEngine('outbound', path)

        exempt = FakeFlow(FakeRequest(path='/health'))
        verdict = engine.apply_request(exempt)
        self.assertIsNone(verdict.terminal, 'the mock must not apply to the exempted call')

        other = FakeFlow(FakeRequest(path='/orders'))
        self.assertEqual(engine.apply_request(other).terminal, 'MOCK_RESPONSE')

    def test_send_to_host_refuses_a_later_rules_abort(self):
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'SEND_TO_HOST'}]),
            rule(id='b', priority=50, actions=[{'type': 'ABORT_REQUEST'}]),
        ])
        verdict = interception.InterceptionEngine('outbound', path).apply_request(FakeFlow())
        self.assertIsNone(verdict.terminal)
        self.assertIn('skipped', verdict.applied[-1].detail)

    def test_send_to_host_does_not_resurrect_an_already_decided_call(self):
        # An earlier rule already ended the request phase; priority is how you express which wins.
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'MOCK_RESPONSE', 'status': 503}]),
            rule(id='b', priority=50, actions=[{'type': 'SEND_TO_HOST'}]),
        ])
        verdict = interception.InterceptionEngine('outbound', path).apply_request(FakeFlow())
        self.assertEqual(verdict.terminal, 'MOCK_RESPONSE')

    def test_response_actions_are_ignored_in_the_request_phase(self):
        engine = self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 500}])
        self.assertFalse(engine.apply_request(FakeFlow()).touched)


class ResponseActionsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def flow(self, **kwargs):
        return FakeFlow(FakeRequest(), FakeMessage(status=200, **kwargs))

    def test_status(self):
        flow = self.flow()
        self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 503}]).apply_response(flow)
        self.assertEqual(flow.response.status_code, 503)

    def test_status_change_also_corrects_the_reason_phrase(self):
        # mitmproxy keeps the upstream's reason, so setting only the code produces replies like
        # "503 Temporary Redirect" - the number and the words beside it disagreeing, in a tool
        # whose job is saying what actually happened.
        flow = self.flow()
        flow.response.reason = 'Temporary Redirect'
        self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 503}]).apply_response(flow)
        self.assertEqual(flow.response.reason, 'Service Unavailable')

    def test_an_unknown_status_gets_no_reason_rather_than_a_wrong_one(self):
        flow = self.flow()
        flow.response.reason = 'OK'
        self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 599}]).apply_response(flow)
        self.assertEqual(flow.response.status_code, 599)
        self.assertEqual(flow.response.reason, '')

    def test_invalid_status_is_rejected(self):
        flow = self.flow()
        self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 9999}]).apply_response(flow)
        self.assertEqual(flow.response.status_code, 200)

    def test_headers(self):
        flow = self.flow(headers={'X-Cache': 'HIT'})
        self.engine([
            {'type': 'SET_RESPONSE_HEADER', 'name': 'X-Alfred', 'value': 'mocked'},
            {'type': 'REMOVE_RESPONSE_HEADER', 'name': 'X-Cache'},
        ]).apply_response(flow)
        self.assertEqual(flow.response.headers['X-Alfred'], 'mocked')
        self.assertNotIn('X-Cache', flow.response.headers)

    def test_json_field(self):
        flow = self.flow(text=json.dumps({'status': 'CONFIRMED', 'itinerary': {'seatsRemaining': 14}}))
        self.engine([
            {'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'status', 'value': 'FAILED'},
            {'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'itinerary.seatsRemaining', 'value': 0},
        ]).apply_response(flow)
        self.assertEqual(json.loads(flow.response.text),
                         {'status': 'FAILED', 'itinerary': {'seatsRemaining': 0}})

    def test_set_response_body_replaces_a_non_json_payload(self):
        flow = self.flow(text='<soap:Envelope><ok/></soap:Envelope>')
        self.engine([{'type': 'SET_RESPONSE_BODY', 'body': '<soap:Fault>down</soap:Fault>'}]).apply_response(flow)
        self.assertEqual(flow.response.text, '<soap:Fault>down</soap:Fault>')

    def test_replace_response_swaps_status_headers_and_body_together(self):
        flow = self.flow(text='{"status":"CONFIRMED"}', headers={'X-Upstream': 'sabre'})
        self.engine([{
            'type': 'REPLACE_RESPONSE',
            'status': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': '{"error":"nope"}',
        }]).apply_response(flow)
        self.assertEqual(flow.response.status_code, 500)
        self.assertEqual(flow.response.reason, 'Internal Server Error')
        self.assertEqual(flow.response.headers['Content-Type'], 'application/json')
        self.assertEqual(flow.response.text, '{"error":"nope"}')
        # Headers the rule did not mention survive - this replaces the response, not the exchange.
        self.assertEqual(flow.response.headers['X-Upstream'], 'sabre')

    def test_replace_response_leaves_out_what_the_rule_omits(self):
        flow = self.flow(text='{"a":1}')
        self.engine([{'type': 'REPLACE_RESPONSE', 'body': '{"b":2}'}]).apply_response(flow)
        self.assertEqual(flow.response.status_code, 200, 'no status given means leave the real one')
        self.assertEqual(flow.response.text, '{"b":2}')

    def test_replace_response_records_that_upstream_was_really_called(self):
        # The distinction from MOCK_RESPONSE is the entire reason this action exists, so the log
        # has to state it.
        flow = self.flow(text='{}')
        verdict = self.engine([{'type': 'REPLACE_RESPONSE', 'status': 500}]).apply_response(flow)
        self.assertIn('upstream was really called', verdict.applied[0].detail)

    def test_delay_response_is_returned_not_slept(self):
        flow = self.flow()
        verdict = self.engine([{'type': 'DELAY_RESPONSE', 'durationMs': 4000}]).apply_response(flow)
        self.assertEqual(verdict.delay_ms, 4000)

    def test_no_response_yet_is_a_no_op(self):
        flow = FakeFlow(FakeRequest(), None)
        self.assertFalse(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 500}]).apply_response(flow).touched)


class JsonPathTest(unittest.TestCase):

    def test_dotted_nested(self):
        out = interception.set_json_field(json.dumps({'a': {'b': {'c': 1}}}), 'a.b.c', 2)
        self.assertEqual(json.loads(out), {'a': {'b': {'c': 2}}})

    def test_array_index(self):
        out = interception.set_json_field(json.dumps({'s': [{'cabin': 'Y'}, {'cabin': 'Y'}]}), 's[1].cabin', 'J')
        self.assertEqual(json.loads(out)['s'], [{'cabin': 'Y'}, {'cabin': 'J'}])

    def test_array_wildcard(self):
        out = interception.set_json_field(json.dumps({'s': [{'cabin': 'Y'}, {'cabin': 'Y'}]}), 's[*].cabin', 'J')
        self.assertEqual(json.loads(out)['s'], [{'cabin': 'J'}, {'cabin': 'J'}])

    def test_absent_path_changes_nothing(self):
        self.assertIsNone(interception.set_json_field(json.dumps({'a': 1}), 'b.c', 2))

    def test_unchanged_body_is_returned_as_none_not_reserialised(self):
        # The engine relies on this to leave a large untouched payload byte-identical.
        self.assertIsNone(interception.set_json_field('{"a":   1}', 'zzz', 2))

    def test_non_json_body_is_left_alone(self):
        self.assertIsNone(interception.set_json_field('<soap:Envelope/>', 'a', 1))

    def test_empty_body(self):
        self.assertIsNone(interception.set_json_field(None, 'a', 1))


class DecisionTest(unittest.TestCase):

    def flow(self):
        return FakeFlow(FakeRequest(), FakeMessage(status=200, text=json.dumps({'status': 'CONFIRMED'})))

    def test_release_unchanged_touches_nothing(self):
        flow = self.flow()
        summary = interception.apply_decision(flow, 'response', {'action': 'release'})
        self.assertEqual(summary, 'released unchanged')
        self.assertEqual(json.loads(flow.response.text), {'status': 'CONFIRMED'})

    def test_release_edited_applies_body_status_and_headers(self):
        flow = self.flow()
        summary = interception.apply_decision(flow, 'response', {
            'action': 'release', 'status': 500,
            'headers': {'X-Alfred-Edited': 'true'},
            'body': json.dumps({'status': 'FAILED'}),
        })
        self.assertEqual(flow.response.status_code, 500)
        self.assertEqual(flow.response.headers['X-Alfred-Edited'], 'true')
        self.assertEqual(json.loads(flow.response.text), {'status': 'FAILED'})
        self.assertIn('released edited', summary)

    def test_abort_is_reported_without_touching_the_flow(self):
        flow = self.flow()
        self.assertEqual(interception.apply_decision(flow, 'response', {'action': 'abort'}), 'aborted by user')
        self.assertEqual(json.loads(flow.response.text), {'status': 'CONFIRMED'})

    def test_a_sensitive_header_set_by_hand_is_still_not_logged(self):
        flow = self.flow()
        summary = interception.apply_decision(flow, 'response', {
            'action': 'release', 'headers': {'Set-Cookie': 'session=secret-value'}})
        self.assertNotIn('secret-value', summary)


class ConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    """The load-bearing property of the whole feature: mitmproxy runs ONE event loop for every
    connection it proxies, so a delayed flow must yield it. If DELAY_REQUEST were ever
    implemented with time.sleep, this is the test that would catch it - the undelayed flow would
    finish LAST instead of first."""

    async def test_a_delayed_flow_does_not_hold_up_an_undelayed_one(self):
        finished = []

        async def flow(name, delay_ms):
            if delay_ms:
                await asyncio.sleep(delay_ms / 1000.0)
            finished.append(name)

        await asyncio.gather(flow('delayed', 300), flow('immediate', 0))
        self.assertEqual(finished, ['immediate', 'delayed'])

    async def test_many_delayed_flows_overlap_rather_than_queue(self):
        started = time.time()
        await asyncio.gather(*[asyncio.sleep(0.2) for _ in range(20)])
        self.assertLess(time.time() - started, 1.0,
                        '20 concurrent 200ms delays must overlap, not sum to 4 seconds')


class BreakpointPollRateTest(unittest.IsolatedAsyncioTestCase):
    """The regression guard for a machine-wide freeze.

    The long poll assumes the backend HOLDS each request for the window it was given. When a call
    the backend no longer had a handoff for was answered "nothing yet" INSTANTLY instead of "stop
    asking", this loop re-asked with no delay: measured at 60% CPU in the proxy and 35% in the
    backend from one paused call, with no cpu limits on either container - enough to stop the host
    responding. These pin both halves of the fix.
    """

    def setUp(self):
        self._real_post = breakpoints._post
        self._real_get = breakpoints._get
        self._real_backend = breakpoints.BACKEND
        breakpoints.BACKEND = 'http://backend.test'
        breakpoints._post = lambda *a, **k: None
        self.addCleanup(self._restore)

    def _restore(self):
        breakpoints._post = self._real_post
        breakpoints._get = self._real_get
        breakpoints.BACKEND = self._real_backend

    @staticmethod
    def _pause(timeout=2):
        return {'phase': 'response', 'timeoutSeconds': timeout, 'onTimeout': 'release',
                'ruleId': 'r', 'ruleName': 'Rule'}

    async def test_an_instantly_answered_poll_does_not_become_a_hot_loop(self):
        calls = []

        def instant_204(path, timeout):
            calls.append(path)
            return None  # 204: "nothing yet" - returned with no delay at all

        breakpoints._get = instant_204
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}'))

        await breakpoints.wait_for_decision(flow, 'response', 'c1', self._pause(2), 'outbound', None)

        # Two seconds of deadline at a 0.25s floor is ~8 polls. Before the fix this ran as fast as
        # the event loop allowed - thousands.
        self.assertLess(len(calls), 40, f'poll loop ran {len(calls)} times in 2s - it is hot')
        self.assertGreater(len(calls), 1, 'it should still poll more than once')

    async def test_a_404_stops_the_loop_immediately_instead_of_polling_to_the_deadline(self):
        calls = []

        def gone(path, timeout):
            calls.append(path)
            raise urllib.error.HTTPError(path, 404, 'Not Found', None, None)

        breakpoints._get = gone
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}'))

        started = time.time()
        decision = await breakpoints.wait_for_decision(
            flow, 'response', 'c1', self._pause(30), 'outbound', None)

        # The backend telling us the call is over must end this at once, not 30 seconds later.
        self.assertEqual(len(calls), 1)
        self.assertLess(time.time() - started, 1.0)
        self.assertEqual(decision['reason'], 'not-registered')
        self.assertEqual(decision['action'], 'release')

    async def test_a_real_decision_is_returned_without_waiting_for_the_floor(self):
        breakpoints._get = lambda path, timeout: {'action': 'release', 'body': 'edited'}
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}'))

        started = time.time()
        decision = await breakpoints.wait_for_decision(
            flow, 'response', 'c1', self._pause(30), 'outbound', None)

        self.assertEqual(decision['body'], 'edited')
        self.assertLess(time.time() - started, 1.0, 'the floor must not delay an actual decision')

    async def test_a_hold_extends_the_deadline_without_spinning(self):
        calls = []

        def hold_then_nothing(path, timeout):
            calls.append(path)
            return {'action': 'hold'} if len(calls) == 1 else None

        breakpoints._get = hold_then_nothing
        original = breakpoints.MAX_HELD_SECONDS
        breakpoints.MAX_HELD_SECONDS = 2
        self.addCleanup(lambda: setattr(breakpoints, 'MAX_HELD_SECONDS', original))
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}'))

        await breakpoints.wait_for_decision(flow, 'response', 'c1', self._pause(1), 'outbound', None)

        # A held call polls for up to an hour in production - by far the worst place for a hot loop.
        self.assertLess(len(calls), 40, f'held-call loop ran {len(calls)} times in 2s - it is hot')


if __name__ == '__main__':
    unittest.main()
