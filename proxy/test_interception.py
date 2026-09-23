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
import threading
import urllib.error

import breakpoints
import interception


def run(coro):
    """The engine's phases are async (a regex find/replace awaits a worker process); these tests
    drive them one call at a time, so each gets its own short-lived loop."""
    return asyncio.run(coro)


class FakeHeaders(dict):
    """mitmproxy's Headers is case-insensitive; dict is not, and the engine relies on the
    difference in two places - REMOVE_*_HEADER's membership test, and a condition looking a
    header up by a name whose casing is not the caller's to predict."""

    def __contains__(self, key):
        return any(k.lower() == key.lower() for k in self.keys())

    def get(self, key, default=None):
        for existing, value in self.items():
            if existing.lower() == (key or '').lower():
                return value
        return default

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

    def get_text(self, strict=True):
        """mitmproxy's own accessor, which _snapshot uses in preference to .text so an
        undecodable binary body yields None rather than raising. Backed by the same attribute the
        mutating actions assign to, so a snapshot taken after an edit would see the edit - which
        is exactly what capture-once exists to prevent."""
        return self.text


class FakeRequest(FakeMessage):
    def __init__(self, method='GET', host='example.com', path='/', text=None, headers=None, query=None):
        FakeMessage.__init__(self, text=text, headers=headers)
        self.method = method
        self.host = host
        self.pretty_host = host
        self.path = path
        self.query = dict(query or {})
        self.scheme = 'https'
        self.port = 443

    @property
    def url(self):
        return self.pretty_url

    @url.setter
    def url(self, value):
        # Enough of mitmproxy's parse for the shared fixture: host, path, query. UrlRequest below
        # models scheme/port/Host-header behaviour properly for the tests that need it.
        _scheme, _, rest = value.partition('://')
        authority, slash, path = rest.partition('/')
        self.host = self.pretty_host = authority.partition(':')[0]
        path, _, query = (slash + path).partition('?')
        self.path = path
        self.query = dict(pair.partition('=')[::2] for pair in query.split('&') if pair)

    @property
    def host_header(self):
        return self.headers.get('Host')

    @host_header.setter
    def host_header(self, value):
        if value is None:
            del self.headers['Host']
        else:
            self.headers['Host'] = value

    @property
    def pretty_url(self):
        """Derived, as mitmproxy's is. It used to be a plain attribute fixed at construction,
        which quietly made SET_QUERY_PARAM untestable: the engine rewrote .query and the url the
        snapshot read never moved, so a query rewrite looked like a no-op to anything comparing
        two snapshots."""
        query = '&'.join(f'{k}={v}' for k, v in self.query.items())
        return f'https://{self.host}{self.path}' + (f'?{query}' if query else '')


class UrlRequest(FakeRequest):
    """A request with mitmproxy's URL semantics: scheme/host/port/path are separate, `url` is built
    from them and setting it sets all four, and setting host or port rewrites a Host header that is
    already present - exactly what mitmproxy.http.Request does, which is what REWRITE_URL relies on."""

    def __init__(self, url='https://api.supplier.com/v1/fares?mode=live', headers=None, **kwargs):
        FakeRequest.__init__(self, headers=headers, **kwargs)
        self.url = url

    def _default_port(self):
        return 443 if self.scheme == 'https' else 80

    def _sync_host_header(self):
        if 'Host' in self.headers:
            self.headers['Host'] = self.host if self.port == self._default_port() else f'{self.host}:{self.port}'

    @property
    def host(self):
        return self._host

    @host.setter
    def host(self, value):
        self._host = value
        self.pretty_host = value
        if hasattr(self, 'port'):
            self._sync_host_header()

    @property
    def port(self):
        return self._port

    @port.setter
    def port(self, value):
        self._port = value
        self._sync_host_header()

    @property
    def host_header(self):
        return self.headers.get('Host')

    @host_header.setter
    def host_header(self, value):
        if value is None:
            del self.headers['Host']
        else:
            self.headers['Host'] = value

    @property
    def url(self):
        port = '' if self.port == self._default_port() else f':{self.port}'
        return f'{self.scheme}://{self.host}{port}{self.path}'

    @url.setter
    def url(self, value):
        scheme, _, rest = value.partition('://')
        authority, slash, path = rest.partition('/')
        host, _, port = authority.partition(':')
        self.scheme = scheme
        self._host = host
        self.pretty_host = host
        self._port = int(port) if port else (443 if scheme == 'https' else 80)
        self.path = slash + path
        self._sync_host_header()

    @property
    def pretty_url(self):
        return self.url


class FakeFlow:
    def __init__(self, request=None, response=None):
        self.request = request or FakeRequest()
        self.response = response
        self.metadata = {}
        self.killed = False

    def kill(self):
        self.killed = True


def write_rules(tmpdir, rules, enabled=True, **extra):
    """`extra` carries the snapshot's other top-level keys (sensitiveHeaders, selfTargets,
    limits), the way the backend's FileRulesPublisherAdapter publishes them."""
    path = os.path.join(tmpdir, 'rules.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'enabled': enabled, 'rules': rules, **extra}, f)
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
        self.assertFalse(run(engine.apply_request(flow)).touched)
        flow = FakeFlow(FakeRequest(method='POST'))
        self.assertTrue(run(engine.apply_request(flow)).touched)

    def test_host_wildcard_matches_subdomain_and_apex(self):
        engine = self.engine([rule(match={'host': '*.sabre.com'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        for host, expected in [('api.sabre.com', True), ('sabre.com', True),
                               ('a.b.sabre.com', True), ('notsabre.com', False),
                               ('sabre.com.evil.net', False)]:
            flow = FakeFlow(FakeRequest(host=host))
            self.assertEqual(run(engine.apply_request(flow)).touched, expected, host)

    def test_source_scopes_a_rule_to_one_direction(self):
        rules = [rule(match={'source': 'inbound'},
                      actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])]
        self.assertFalse(run(self.engine(rules, 'outbound').apply_request(FakeFlow())).touched)
        self.assertTrue(run(self.engine(rules, 'inbound').apply_request(FakeFlow())).touched)

    def test_path_regex_and_contains(self):
        engine = self.engine([rule(match={'pathRegex': r'/v\d+/order'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertTrue(run(engine.apply_request(FakeFlow(FakeRequest(path='/v4/order/create')))).touched)
        self.assertFalse(run(engine.apply_request(FakeFlow(FakeRequest(path='/vx/order')))).touched)

    def test_service_names_scope_a_rule_to_several_projects(self):
        engine = self.engine([rule(match={'serviceNames': ['Core-service', 'odeysys']},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertTrue(run(engine.apply_request(FakeFlow(), 'Core-service')).touched)
        self.assertTrue(run(engine.apply_request(FakeFlow(), 'odeysys')).touched)
        self.assertFalse(run(engine.apply_request(FakeFlow(), 'ndc-gateway')).touched)
        self.assertFalse(run(engine.apply_request(FakeFlow(), None)).touched)

    def test_an_empty_project_list_matches_every_project(self):
        engine = self.engine([rule(match={'serviceNames': []},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertTrue(run(engine.apply_request(FakeFlow(), 'anything')).touched)
        self.assertTrue(run(engine.apply_request(FakeFlow(), None)).touched)

    def test_a_rule_saved_before_the_field_was_a_list_still_scopes(self):
        # The rules file on disk can be older than this container. Ignoring the single-name shape
        # would silently widen a project-scoped rule to ALL traffic, which is the worst direction
        # for that mistake to go.
        engine = self.engine([rule(match={'serviceName': 'Core-service'},
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertFalse(run(engine.apply_request(FakeFlow(), 'Odeysys')).touched)
        self.assertTrue(run(engine.apply_request(FakeFlow(), 'Core-service')).touched)

    def test_disabled_rule_never_applies(self):
        engine = self.engine([rule(enabled=False,
                                   actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])])
        self.assertFalse(run(engine.apply_request(FakeFlow())).touched)

    def test_master_switch_off_disables_every_rule(self):
        engine = self.engine([rule(actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])],
                             enabled=False)
        self.assertFalse(run(engine.apply_request(FakeFlow())).touched)

    def test_missing_rules_file_is_inert_not_an_error(self):
        engine = interception.InterceptionEngine('outbound', os.path.join(self.tmp.name, 'nope.json'))
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
        self.assertFalse(verdict.touched)
        self.assertIsNone(verdict.as_log())

    def test_corrupt_rules_file_disables_rather_than_crashes(self):
        path = os.path.join(self.tmp.name, 'bad.json')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('{ this is not json')
        engine = interception.InterceptionEngine('outbound', path)
        self.assertFalse(run(engine.apply_request(FakeFlow())).touched)

    def test_rules_are_reloaded_when_the_file_changes(self):
        path = write_rules(self.tmp.name, [])
        engine = interception.InterceptionEngine('outbound', path)
        self.assertFalse(run(engine.apply_request(FakeFlow())).touched)
        time.sleep(0.01)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'enabled': True, 'rules': [
                rule(actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-T', 'value': '1'}])]}, f)
        os.utime(path, (time.time() + 1, time.time() + 1))
        self.assertTrue(run(engine.apply_request(FakeFlow())).touched)

    def test_all_matching_rules_apply_in_priority_order(self):
        engine = self.engine([
            rule(id='b', name='second', priority=20,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-Order', 'value': 'b'}]),
            rule(id='a', name='first', priority=10,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-Order', 'value': 'a'}]),
        ])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
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
        verdict = run(engine.apply_request(flow))
        self.assertEqual([a.rule_name for a in verdict.applied], ['first'])

    def test_a_rule_that_throws_is_skipped_not_fatal(self):
        engine = self.engine([
            rule(id='a', name='broken', priority=10,
                 actions=[{'type': 'SET_REQUEST_JSON_FIELD', 'path': None, 'value': 1}]),
            rule(id='b', name='fine', priority=20,
                 actions=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-B', 'value': '1'}]),
        ])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
        self.assertEqual(flow.request.headers['X-B'], '1')
        # The broken rule changed nothing and says so, rather than vanishing from the record.
        self.assertEqual([(a.rule_name, a.detail) for a in verdict.applied],
                         [('broken', 'skipped - path not found'), ('fine', 'X-B')])


class RequestActionsTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def test_delay_is_returned_not_slept(self):
        started = time.time()
        verdict = run(self.engine([{'type': 'DELAY_REQUEST', 'durationMs': 5000}]).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, 5000)
        self.assertLess(time.time() - started, 0.5, 'engine must never sleep on its own thread')

    def test_delays_sum_across_rules_and_are_clamped(self):
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'DELAY_REQUEST', 'durationMs': 2000}]),
            rule(id='b', priority=2, actions=[{'type': 'DELAY_REQUEST', 'durationMs': 3000}]),
        ])
        verdict = run(interception.InterceptionEngine('outbound', path).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, 5000)

    def test_delay_over_the_ceiling_is_capped(self):
        verdict = run(self.engine([{'type': 'DELAY_REQUEST', 'durationMs': 99999999}]).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, interception.MAX_DELAY_MS)

    def test_set_and_remove_request_header(self):
        engine = self.engine([
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Alfred-Test', 'value': 'true'},
            {'type': 'REMOVE_REQUEST_HEADER', 'name': 'X-Drop-Me'},
        ])
        flow = FakeFlow(FakeRequest(headers={'X-Drop-Me': 'gone'}))
        run(engine.apply_request(flow))
        self.assertEqual(flow.request.headers['X-Alfred-Test'], 'true')
        self.assertNotIn('X-Drop-Me', flow.request.headers)

    def test_sensitive_header_value_is_never_recorded(self):
        engine = self.engine([{'type': 'SET_REQUEST_HEADER', 'name': 'Authorization', 'value': 'Bearer hunter2'}])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
        serialised = json.dumps(verdict.as_log())
        self.assertIn('Bearer hunter2', flow.request.headers['Authorization'])
        self.assertNotIn('hunter2', serialised)

    def test_query_params(self):
        engine = self.engine([
            {'type': 'SET_QUERY_PARAM', 'name': 'passengers', 'value': '5'},
            {'type': 'REMOVE_QUERY_PARAM', 'name': 'debug'},
        ])
        flow = FakeFlow(FakeRequest(query={'passengers': '1', 'debug': '1'}))
        run(engine.apply_request(flow))
        self.assertEqual(flow.request.query['passengers'], '5')
        self.assertNotIn('debug', flow.request.query)

    def test_json_body_field(self):
        engine = self.engine([
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'passengerCount', 'value': 5},
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'currency', 'value': 'EUR'},
        ])
        flow = FakeFlow(FakeRequest(text=json.dumps({'passengerCount': 1, 'currency': 'USD'})))
        run(engine.apply_request(flow))
        self.assertEqual(json.loads(flow.request.text), {'passengerCount': 5, 'currency': 'EUR'})

    def test_abort_is_terminal(self):
        engine = self.engine([
            {'type': 'ABORT_REQUEST'},
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Never', 'value': '1'},
        ])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
        self.assertEqual(verdict.terminal, 'ABORT_REQUEST')
        self.assertNotIn('X-Never', flow.request.headers)

    def test_mock_response_is_terminal_and_carries_its_payload(self):
        engine = self.engine([
            {'type': 'MOCK_RESPONSE', 'status': 500, 'headers': {'Content-Type': 'application/json'},
             'body': '{"error":"Simulated supplier failure"}'},
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Never', 'value': '1'},
        ])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
        self.assertEqual(verdict.terminal, 'MOCK_RESPONSE')
        self.assertEqual(verdict.mock['status'], 500)
        self.assertNotIn('X-Never', flow.request.headers)

    def test_send_to_host_on_its_own_forwards_and_records_itself(self):
        engine = self.engine([{'type': 'SEND_TO_HOST'}])
        flow = FakeFlow()
        verdict = run(engine.apply_request(flow))
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
        verdict = run(engine.apply_request(exempt))
        self.assertIsNone(verdict.terminal, 'the mock must not apply to the exempted call')

        other = FakeFlow(FakeRequest(path='/orders'))
        self.assertEqual(run(engine.apply_request(other)).terminal, 'MOCK_RESPONSE')

    def test_send_to_host_refuses_a_later_rules_abort(self):
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'SEND_TO_HOST'}]),
            rule(id='b', priority=50, actions=[{'type': 'ABORT_REQUEST'}]),
        ])
        verdict = run(interception.InterceptionEngine('outbound', path).apply_request(FakeFlow()))
        self.assertIsNone(verdict.terminal)
        self.assertIn('skipped', verdict.applied[-1].detail)

    def test_send_to_host_does_not_resurrect_an_already_decided_call(self):
        # An earlier rule already ended the request phase; priority is how you express which wins.
        path = write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'MOCK_RESPONSE', 'status': 503}]),
            rule(id='b', priority=50, actions=[{'type': 'SEND_TO_HOST'}]),
        ])
        verdict = run(interception.InterceptionEngine('outbound', path).apply_request(FakeFlow()))
        self.assertEqual(verdict.terminal, 'MOCK_RESPONSE')

    def test_response_actions_are_ignored_in_the_request_phase(self):
        engine = self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 500}])
        self.assertFalse(run(engine.apply_request(FakeFlow())).touched)


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
        run(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 503}]).apply_response(flow))
        self.assertEqual(flow.response.status_code, 503)

    def test_status_change_also_corrects_the_reason_phrase(self):
        # mitmproxy keeps the upstream's reason, so setting only the code produces replies like
        # "503 Temporary Redirect" - the number and the words beside it disagreeing, in a tool
        # whose job is saying what actually happened.
        flow = self.flow()
        flow.response.reason = 'Temporary Redirect'
        run(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 503}]).apply_response(flow))
        self.assertEqual(flow.response.reason, 'Service Unavailable')

    def test_an_unknown_status_gets_no_reason_rather_than_a_wrong_one(self):
        flow = self.flow()
        flow.response.reason = 'OK'
        run(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 599}]).apply_response(flow))
        self.assertEqual(flow.response.status_code, 599)
        self.assertEqual(flow.response.reason, '')

    def test_invalid_status_is_rejected(self):
        flow = self.flow()
        run(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 9999}]).apply_response(flow))
        self.assertEqual(flow.response.status_code, 200)

    def test_headers(self):
        flow = self.flow(headers={'X-Cache': 'HIT'})
        run(self.engine([
            {'type': 'SET_RESPONSE_HEADER', 'name': 'X-Alfred', 'value': 'mocked'},
            {'type': 'REMOVE_RESPONSE_HEADER', 'name': 'X-Cache'},
        ]).apply_response(flow))
        self.assertEqual(flow.response.headers['X-Alfred'], 'mocked')
        self.assertNotIn('X-Cache', flow.response.headers)

    def test_json_field(self):
        flow = self.flow(text=json.dumps({'status': 'CONFIRMED', 'itinerary': {'seatsRemaining': 14}}))
        run(self.engine([
            {'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'status', 'value': 'FAILED'},
            {'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'itinerary.seatsRemaining', 'value': 0},
        ]).apply_response(flow))
        self.assertEqual(json.loads(flow.response.text),
                         {'status': 'FAILED', 'itinerary': {'seatsRemaining': 0}})

    def test_set_response_body_replaces_a_non_json_payload(self):
        flow = self.flow(text='<soap:Envelope><ok/></soap:Envelope>')
        run(self.engine([{'type': 'SET_RESPONSE_BODY', 'body': '<soap:Fault>down</soap:Fault>'}]).apply_response(flow))
        self.assertEqual(flow.response.text, '<soap:Fault>down</soap:Fault>')

    def test_replace_response_swaps_status_headers_and_body_together(self):
        flow = self.flow(text='{"status":"CONFIRMED"}', headers={'X-Upstream': 'sabre'})
        run(self.engine([{
            'type': 'REPLACE_RESPONSE',
            'status': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': '{"error":"nope"}',
        }]).apply_response(flow))
        self.assertEqual(flow.response.status_code, 500)
        self.assertEqual(flow.response.reason, 'Internal Server Error')
        self.assertEqual(flow.response.headers['Content-Type'], 'application/json')
        self.assertEqual(flow.response.text, '{"error":"nope"}')
        # Headers the rule did not mention survive - this replaces the response, not the exchange.
        self.assertEqual(flow.response.headers['X-Upstream'], 'sabre')

    def test_replace_response_leaves_out_what_the_rule_omits(self):
        flow = self.flow(text='{"a":1}')
        run(self.engine([{'type': 'REPLACE_RESPONSE', 'body': '{"b":2}'}]).apply_response(flow))
        self.assertEqual(flow.response.status_code, 200, 'no status given means leave the real one')
        self.assertEqual(flow.response.text, '{"b":2}')

    def test_replace_response_records_that_upstream_was_really_called(self):
        # The distinction from MOCK_RESPONSE is the entire reason this action exists, so the log
        # has to state it.
        flow = self.flow(text='{}')
        verdict = run(self.engine([{'type': 'REPLACE_RESPONSE', 'status': 500}]).apply_response(flow))
        self.assertIn('upstream was really called', verdict.applied[0].detail)

    def test_delay_response_is_returned_not_slept(self):
        flow = self.flow()
        verdict = run(self.engine([{'type': 'DELAY_RESPONSE', 'durationMs': 4000}]).apply_response(flow))
        self.assertEqual(verdict.delay_ms, 4000)

    def test_no_response_yet_is_a_no_op(self):
        flow = FakeFlow(FakeRequest(), None)
        self.assertFalse(run(self.engine([{'type': 'SET_RESPONSE_STATUS', 'status': 500}]).apply_response(flow)).touched)


class BeforeAfterTest(unittest.TestCase):
    """Every half must keep what it looked like before anything touched it, and what it looked
    like after everything had.

    Without this the log actively misleads: a request rewritten by a rule is recorded as though
    the client sent it that way, so "the booking failed" cannot be traced back to the edit that
    caused it.

    What this suite is really pinning is HOW that happens. The snapshots are taken by the engine
    on both sides of a whole phase and compared - no action declares that it is about to change
    something. An earlier design had each action call capture_*() itself, which meant a new
    action silently had no before/after until somebody remembered, and a response-phase verdict
    whose snapshots the addon forgot to carry across lost them all with nothing failing.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def run_request(self, actions, flow):
        """What the addon does around a request, minus the event loop."""
        verdict = run(self.engine(actions).apply_request(flow))
        verdict.finalize_request(flow)
        return verdict

    def run_response(self, actions, flow):
        verdict = run(self.engine(actions).apply_response(flow))
        verdict.finalize_response(flow)
        return verdict

    def test_an_untouched_call_captures_nothing(self):
        verdict = self.run_request([{'type': 'DELAY_REQUEST', 'durationMs': 10}],
                                   FakeFlow(FakeRequest(text='{"a":1}')))
        # A delay changes no content, so there is nothing to show a before/after of - and storing
        # two identical copies of every delayed call's body would be pure waste.
        self.assertIsNone(verdict.original_request)
        self.assertNotIn('originalRequest', verdict.as_log())

    def test_an_edit_that_changes_nothing_records_nothing(self):
        # The header is already what the rule sets it to. The action ran and is reported in
        # `applied`; there is still no difference to show.
        flow = FakeFlow(FakeRequest(headers={'X-Alfred': 'on'}))
        verdict = self.run_request([{'type': 'SET_REQUEST_HEADER', 'name': 'X-Alfred', 'value': 'on'}], flow)

        self.assertIsNone(verdict.original_request)
        self.assertIsNone(verdict.final_request)
        self.assertTrue(verdict.applied)

    def test_a_rewritten_request_body_keeps_both_ends(self):
        flow = FakeFlow(FakeRequest(text=json.dumps({'passengerCount': 1})))
        verdict = self.run_request(
            [{'type': 'SET_REQUEST_JSON_FIELD', 'path': 'passengerCount', 'value': 5}], flow)

        log = verdict.as_log()
        self.assertEqual(json.loads(log['originalRequest']['body']), {'passengerCount': 1})
        self.assertEqual(json.loads(log['finalRequest']['body']), {'passengerCount': 5})

    def test_a_rewritten_header_keeps_the_original_headers(self):
        flow = FakeFlow(FakeRequest(headers={'content-type': 'application/json'}))
        verdict = self.run_request([{'type': 'SET_REQUEST_HEADER', 'name': 'X-Alfred', 'value': 'on'}], flow)

        self.assertNotIn('X-Alfred', verdict.original_request['headers'])
        self.assertIn('X-Alfred', verdict.final_request['headers'])

    def test_a_query_rewrite_is_visible_in_the_url(self):
        # The url is the ONLY thing a query rewrite changes, so a snapshot without it would show
        # two identical copies and the change would look like a bug.
        flow = FakeFlow(FakeRequest(path='/search', query={'passengers': '1'}))
        verdict = self.run_request([{'type': 'SET_QUERY_PARAM', 'name': 'passengers', 'value': '5'}], flow)

        self.assertEqual(verdict.original_request['url'], 'https://example.com/search?passengers=1')
        self.assertEqual(verdict.final_request['url'], 'https://example.com/search?passengers=5')
        self.assertEqual(verdict.original_request['method'], 'GET')

    def test_two_edits_to_one_half_still_report_the_true_original(self):
        flow = FakeFlow(FakeRequest(text=json.dumps({'a': 1})))
        verdict = self.run_request([
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'a', 'value': 2},
            {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'a', 'value': 3},
        ], flow)

        # Two edits, one original - and it is the value before EITHER of them.
        self.assertEqual(json.loads(verdict.original_request['body']), {'a': 1})
        self.assertEqual(json.loads(verdict.final_request['body']), {'a': 3})

    def test_a_rewritten_response_keeps_what_upstream_really_sent(self):
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text=json.dumps({'status': 'CONFIRMED'})))
        verdict = self.run_response(
            [{'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'status', 'value': 'FAILED'}], flow)

        self.assertEqual(json.loads(verdict.original_response['body']), {'status': 'CONFIRMED'})
        self.assertEqual(verdict.original_response['status'], 200)
        self.assertEqual(json.loads(verdict.final_response['body']), {'status': 'FAILED'})

    def test_a_status_change_keeps_the_original_status_and_reason(self):
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}'))
        flow.response.reason = 'OK'
        verdict = self.run_response([{'type': 'SET_RESPONSE_STATUS', 'status': 500}], flow)

        self.assertEqual(verdict.original_response['status'], 200)
        self.assertEqual(verdict.original_response['reason'], 'OK')
        self.assertEqual(verdict.final_response['status'], 500)

    def test_replace_response_keeps_the_real_upstream_answer(self):
        # The case from the field: this produced no before/after at all, because the addon copied
        # only `applied` off the response verdict and dropped the snapshots with it.
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{"real":true}'))
        verdict = self.run_response([{'type': 'REPLACE_RESPONSE', 'status': 503, 'body': 'nope'}], flow)

        self.assertEqual(verdict.original_response['body'], '{"real":true}')
        self.assertEqual(verdict.original_response['status'], 200)
        self.assertEqual(verdict.final_response['body'], 'nope')
        self.assertEqual(verdict.final_response['status'], 503)

    def test_a_response_verdict_adopted_by_the_flows_verdict_keeps_its_snapshots(self):
        # Pins the addon's merge directly: the response phase builds its own verdict because it
        # has its own delay and pause, but the record is one record per call.
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text='{"real":true}'))
        carried = interception.Verdict()
        response_verdict = run(self.engine([{'type': 'SET_RESPONSE_BODY', 'body': 'x'}]).apply_response(flow))

        carried.adopt(response_verdict)
        carried.finalize_response(flow)

        self.assertEqual(carried.original_response['body'], '{"real":true}')
        self.assertEqual(carried.final_response['body'], 'x')

    def test_a_rule_edit_followed_by_a_hand_edit_still_records_the_true_original(self):
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text=json.dumps({'status': 'REAL'})))
        engine = self.engine([{'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'status', 'value': 'RULE'}])
        verdict = run(engine.apply_response(flow))

        interception.apply_decision(flow, 'response', {'action': 'release', 'body': '{"status":"HAND"}'})
        verdict.finalize_response(flow)

        self.assertEqual(json.loads(verdict.original_response['body']), {'status': 'REAL'})
        self.assertEqual(json.loads(verdict.final_response['body']), {'status': 'HAND'})

    def test_a_hand_edited_request_is_recorded_even_though_the_log_predates_it(self):
        # The call log cannot be the "after" side for a request: it is written at prepare time,
        # BEFORE a request breakpoint lets anyone edit. Without both ends here the diff would
        # show no change while the record insisted one was made - which is what happened on real
        # traffic.
        flow = FakeFlow(FakeRequest(text=json.dumps({'a': 1})))
        engine = self.engine([{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 5}])
        verdict = run(engine.apply_request(flow))

        interception.apply_decision(flow, 'request', {'action': 'release', 'body': '{"a":99}'})
        verdict.finalize_request(flow)

        log = verdict.as_log()
        self.assertEqual(json.loads(log['originalRequest']['body']), {'a': 1})
        self.assertEqual(json.loads(log['finalRequest']['body']), {'a': 99})

    def test_a_mocked_response_is_reported_as_one_sided_rather_than_as_a_diff(self):
        # Upstream was never contacted, so there is no "before" to diff against. Recording the
        # mock as both sides would claim the host answered and that we changed its answer.
        flow = FakeFlow(FakeRequest())
        engine = self.engine([{'type': 'MOCK_RESPONSE', 'status': 418, 'body': 'teapot'}])
        verdict = run(engine.apply_request(flow))
        flow.response = FakeMessage(status=418, text='teapot')  # what the addon does next
        verdict.finalize_request(flow)

        log = verdict.as_log()
        self.assertNotIn('originalResponse', log)
        self.assertEqual(log['finalResponse']['body'], 'teapot')
        self.assertTrue(verdict.synthetic_response)

    def test_a_rule_that_edits_a_mock_does_not_pass_the_mock_off_as_upstreams_answer(self):
        flow = FakeFlow(FakeRequest())
        verdict = interception.Verdict()
        verdict.synthetic_response = True
        flow.response = FakeMessage(status=418, text='teapot')

        response_verdict = run(self.engine([{'type': 'SET_RESPONSE_BODY', 'body': 'edited'}]).apply_response(flow))
        verdict.adopt(response_verdict)
        verdict.finalize_response(flow)

        self.assertIsNone(verdict.original_response)
        self.assertEqual(verdict.final_response['body'], 'edited')

    def test_finalize_is_safe_when_there_is_no_response_at_all(self):
        verdict = interception.Verdict()
        flow = FakeFlow(FakeRequest(), None)
        verdict.finalize_request(flow)
        verdict.finalize_response(flow)
        self.assertIsNone(verdict.original_response)
        self.assertIsNone(verdict.final_response)


class SimulateFailureTest(unittest.TestCase):
    """The failures a supplier produces that are not a status code.

    What each mode means is decided by `failure_plan` and carried out by the addons, so these
    assert the plan rather than a flow: the addon's share is two lines that touch mitmproxy, and
    the part worth pinning is that a mode does what its name says and that an unrecognised one
    does nothing at all.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, action):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=[action])]))

    def verdict(self, **action):
        action.setdefault('type', 'SIMULATE_FAILURE')
        return run(self.engine(action).apply_request(FakeFlow(FakeRequest(text='{}'))))

    def test_a_failure_ends_the_request_phase(self):
        verdict = self.verdict(failure='CONNECTION_RESET')
        self.assertEqual(verdict.terminal, 'SIMULATE_FAILURE')
        self.assertEqual(verdict.failure['mode'], 'CONNECTION_RESET')

    def test_a_reset_kills_the_connection_with_no_reply(self):
        plan = interception.failure_plan(self.verdict(failure='CONNECTION_RESET').failure)
        self.assertTrue(plan['kill'])
        self.assertIsNone(plan['response'])
        self.assertEqual(plan['sleep'], 0)

    def test_hanging_then_dropping_waits_first(self):
        plan = interception.failure_plan(self.verdict(failure='HANG_THEN_DROP', durationMs=4500).failure)
        self.assertEqual(plan['sleep'], 4.5)
        self.assertTrue(plan['kill'])

    def test_hanging_is_capped_even_when_the_rule_asks_for_longer(self):
        plan = interception.failure_plan(
            self.verdict(failure='HANG_THEN_DROP', durationMs=99_999_999).failure)
        self.assertEqual(plan['sleep'], interception.MAX_DELAY_MS / 1000.0)

    def test_hanging_until_the_caller_gives_up_still_has_a_ceiling(self):
        # The caller's own timeout is what should end this. The cap only stops a client with no
        # timeout at all from pinning a connection open forever.
        plan = interception.failure_plan(self.verdict(failure='HANG_UNTIL_CALLER_GIVES_UP').failure)
        self.assertEqual(plan['sleep'], interception.MAX_HANG_SECONDS)
        self.assertTrue(plan['kill'])

    def test_an_empty_reply_is_a_valid_response_with_no_body(self):
        plan = interception.failure_plan(self.verdict(failure='EMPTY_REPLY').failure)
        self.assertFalse(plan['kill'])
        self.assertEqual(plan['response']['status'], 200)
        self.assertEqual(plan['response']['body'], '')

    def test_a_truncated_body_promises_more_than_it_sends(self):
        body = '{"offers":[1,2,3,4,5,6,7,8]}'
        plan = interception.failure_plan(self.verdict(failure='TRUNCATED_BODY', body=body).failure)

        sent = plan['response']['body']
        self.assertTrue(body.startswith(sent))
        self.assertLess(len(sent), len(body))
        # The declared length is the WHOLE body - that mismatch is the entire failure.
        self.assertEqual(plan['response']['declaredLength'], len(body.encode('utf-8')))
        # Keep-alive would leave the promise of more bytes stalling the next request on the socket.
        self.assertEqual(plan['response']['headers']['connection'], 'close')

    def test_a_truncated_body_still_sends_something_however_short(self):
        plan = interception.failure_plan(self.verdict(failure='TRUNCATED_BODY', body='xy').failure)
        self.assertEqual(plan['response']['body'], 'x')

    def test_a_gateway_failure_replies_without_contacting_the_host(self):
        plan = interception.failure_plan(self.verdict(failure='GATEWAY_ERROR', status=504).failure)
        self.assertEqual(plan['response']['status'], 504)
        self.assertIn('upstream', plan['response']['body'].lower())

    def test_a_gateway_failure_with_a_status_it_could_not_be_falls_back(self):
        plan = interception.failure_plan(self.verdict(failure='GATEWAY_ERROR', status=200).failure)
        self.assertEqual(plan['response']['status'], 502)

    def test_an_unknown_failure_is_refused_rather_than_guessed(self):
        # Turning a typo into "reset the connection" would kill a live call nobody asked to kill.
        verdict = self.verdict(failure='DNS_MELTDOWN')
        self.assertIsNone(verdict.terminal)
        self.assertIsNone(verdict.failure)
        self.assertIn('unknown failure', verdict.applied[0].detail)

    def test_a_failure_with_no_mode_at_all_is_refused(self):
        verdict = self.verdict()
        self.assertIsNone(verdict.terminal)

    def test_an_unknown_mode_reaching_the_plan_by_hand_does_nothing(self):
        plan = interception.failure_plan({'mode': 'NONSENSE'})
        self.assertFalse(plan['kill'])
        self.assertIsNone(plan['response'])

    def test_send_to_host_refuses_a_later_failure(self):
        # Same latch as MOCK_RESPONSE and ABORT_REQUEST: "always really call this endpoint" has to
        # beat a broad rule that breaks everything.
        engine = interception.InterceptionEngine('outbound', write_rules(self.tmp.name, [
            rule(id='a', priority=1, actions=[{'type': 'SEND_TO_HOST'}]),
            rule(id='b', priority=2, actions=[{'type': 'SIMULATE_FAILURE', 'failure': 'CONNECTION_RESET'}]),
        ]))
        verdict = run(engine.apply_request(FakeFlow()))

        self.assertIsNone(verdict.terminal)
        self.assertIn('skipped', verdict.applied[-1].detail)

    def test_the_log_says_what_broke_in_plain_english(self):
        verdict = self.verdict(failure='EMPTY_REPLY')
        self.assertEqual(verdict.as_log()['applied'][0]['detail'], 'empty reply, upstream never contacted')


class ConditionTest(unittest.TestCase):
    """Conditions: "look at the call, then decide".

    Most of these assert one operator against one subject, because the combinations are the whole
    surface and a quiet wrong answer in any of them sends a call down the wrong branch.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def holds(self, condition, flow):
        return interception.Condition(condition).holds(flow)

    def request_flow(self, **kwargs):
        return FakeFlow(FakeRequest(**kwargs))

    # ---- existence ----------------------------------------------------------------------

    def test_exists_and_not_exists_on_a_header(self):
        flow = self.request_flow(headers={'X-Api-Key': 'abc'})
        self.assertTrue(self.holds({'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'EXISTS'}, flow))
        self.assertFalse(self.holds({'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'NOT_EXISTS'}, flow))
        self.assertTrue(self.holds({'subject': 'REQUEST_HEADER', 'name': 'nope', 'operator': 'NOT_EXISTS'}, flow))

    def test_a_header_is_found_whatever_its_casing(self):
        # HTTP header names are case-insensitive and the casing a supplier chooses is not the
        # rule author's to predict.
        flow = self.request_flow(headers={'X-Api-Key': 'abc'})
        self.assertTrue(self.holds({'subject': 'REQUEST_HEADER', 'name': 'X-API-KEY', 'operator': 'EXISTS'}, flow))

    def test_an_empty_header_still_exists(self):
        flow = self.request_flow(headers={'X-Trace': ''})
        self.assertTrue(self.holds({'subject': 'REQUEST_HEADER', 'name': 'x-trace', 'operator': 'EXISTS'}, flow))

    # ---- the absent-subject rule --------------------------------------------------------

    def test_an_absent_subject_satisfies_the_negative_operators_and_no_others(self):
        # The one semantic here that surprises people, so it is pinned: a header that was never
        # sent is not equal to anything, does not contain anything, and matches nothing - which
        # makes every NOT_ form true.
        flow = self.request_flow()
        for operator in ('NOT_EQUALS', 'NOT_CONTAINS', 'NOT_MATCHES'):
            self.assertTrue(
                self.holds({'subject': 'REQUEST_HEADER', 'name': 'absent', 'operator': operator, 'value': 'x'}, flow),
                operator)
        for operator in ('EQUALS', 'CONTAINS', 'MATCHES', 'AT_LEAST', 'AT_MOST'):
            self.assertFalse(
                self.holds({'subject': 'REQUEST_HEADER', 'name': 'absent', 'operator': operator, 'value': '1'}, flow),
                operator)

    # ---- comparison ---------------------------------------------------------------------

    def test_equals_ignores_case_unless_asked_not_to(self):
        flow = self.request_flow(headers={'X-Env': 'STAGING'})
        base = {'subject': 'REQUEST_HEADER', 'name': 'x-env', 'operator': 'EQUALS', 'value': 'staging'}
        self.assertTrue(self.holds(base, flow))
        self.assertFalse(self.holds({**base, 'caseSensitive': True}, flow))

    def test_contains_is_a_substring_of_the_value(self):
        flow = self.request_flow(headers={'User-Agent': 'Java/1.8.0_191'})
        self.assertTrue(self.holds(
            {'subject': 'REQUEST_HEADER', 'name': 'user-agent', 'operator': 'CONTAINS', 'value': 'java/1.8'}, flow))
        self.assertFalse(self.holds(
            {'subject': 'REQUEST_HEADER', 'name': 'user-agent', 'operator': 'CONTAINS', 'value': 'curl'}, flow))

    def test_matches_uses_a_regex_compiled_once_at_load(self):
        flow = self.request_flow(headers={'X-Version': 'v4.2.1'})
        condition = interception.Condition(
            {'subject': 'REQUEST_HEADER', 'name': 'x-version', 'operator': 'MATCHES', 'value': r'^v\d+\.\d+'})
        self.assertIsNotNone(condition.pattern)
        self.assertTrue(condition.holds(flow))

    def test_numeric_comparison_on_a_status(self):
        flow = FakeFlow(FakeRequest(), FakeMessage(status=503, text=''))
        self.assertTrue(self.holds({'subject': 'RESPONSE_STATUS', 'operator': 'AT_LEAST', 'value': '500'}, flow))
        self.assertFalse(self.holds({'subject': 'RESPONSE_STATUS', 'operator': 'AT_MOST', 'value': '499'}, flow))

    def test_a_non_numeric_value_fails_a_numeric_test_rather_than_throwing(self):
        flow = self.request_flow(headers={'X-Count': 'many'})
        self.assertFalse(self.holds(
            {'subject': 'REQUEST_HEADER', 'name': 'x-count', 'operator': 'AT_LEAST', 'value': '1'}, flow))

    # ---- subjects -----------------------------------------------------------------------

    def test_body_url_and_method_subjects(self):
        flow = self.request_flow(method='POST', path='/v4/order', text='{"currency":"EGP"}')
        self.assertTrue(self.holds({'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'post'}, flow))
        self.assertTrue(self.holds({'subject': 'URL', 'operator': 'CONTAINS', 'value': '/v4/order'}, flow))
        self.assertTrue(self.holds({'subject': 'REQUEST_BODY', 'operator': 'CONTAINS', 'value': 'EGP'}, flow))

    def test_query_parameter_subject(self):
        flow = self.request_flow(query={'debug': 'true'})
        self.assertTrue(self.holds({'subject': 'QUERY_PARAM', 'name': 'debug', 'operator': 'EQUALS', 'value': 'true'}, flow))
        self.assertTrue(self.holds({'subject': 'QUERY_PARAM', 'name': 'other', 'operator': 'NOT_EXISTS'}, flow))

    def test_json_field_subject_reads_a_nested_value(self):
        flow = self.request_flow(text=json.dumps({'itinerary': {'seatsRemaining': 2}}))
        self.assertTrue(self.holds(
            {'subject': 'REQUEST_JSON_FIELD', 'name': 'itinerary.seatsRemaining', 'operator': 'AT_MOST', 'value': '3'},
            flow))

    def test_a_wildcard_path_holds_when_any_element_matches(self):
        # `[*]` resolves to several values, so the honest reading of "contains" is "any of them
        # does" - and its negative is "none of them does", which is the only pairing under which
        # a condition and its negation cannot both be true.
        flow = self.request_flow(text=json.dumps({'segments': [{'cabin': 'Y'}, {'cabin': 'J'}]}))
        self.assertTrue(self.holds(
            {'subject': 'REQUEST_JSON_FIELD', 'name': 'segments[*].cabin', 'operator': 'EQUALS', 'value': 'J'}, flow))
        self.assertFalse(self.holds(
            {'subject': 'REQUEST_JSON_FIELD', 'name': 'segments[*].cabin', 'operator': 'NOT_EQUALS', 'value': 'J'}, flow))
        self.assertTrue(self.holds(
            {'subject': 'REQUEST_JSON_FIELD', 'name': 'segments[*].cabin', 'operator': 'NOT_EQUALS', 'value': 'F'}, flow))

    def test_a_missing_json_field_is_absent_not_an_error(self):
        flow = self.request_flow(text='{"a":1}')
        self.assertTrue(self.holds({'subject': 'REQUEST_JSON_FIELD', 'name': 'b.c', 'operator': 'NOT_EXISTS'}, flow))

    def test_a_body_that_is_not_json_is_absent_for_a_field_condition(self):
        flow = self.request_flow(text='<soap:Envelope/>')
        self.assertTrue(self.holds({'subject': 'REQUEST_JSON_FIELD', 'name': 'a', 'operator': 'NOT_EXISTS'}, flow))

    def test_a_response_subject_read_in_the_request_phase_is_simply_absent(self):
        # The backend refuses to save this; a hand-edited file must not make it throw.
        flow = self.request_flow()
        self.assertFalse(self.holds({'subject': 'RESPONSE_STATUS', 'operator': 'EQUALS', 'value': '200'}, flow))

    def test_an_unknown_subject_or_operator_never_matches(self):
        # A branch that runs because a typo was ignored is worse than one that never runs.
        flow = self.request_flow(headers={'X-A': '1'})
        self.assertFalse(self.holds({'subject': 'WISHFUL', 'operator': 'EXISTS'}, flow))
        self.assertFalse(self.holds({'subject': 'REQUEST_HEADER', 'name': 'x-a', 'operator': 'SORT_OF'}, flow))

    # ---- describe -----------------------------------------------------------------------

    def test_a_condition_on_a_secret_header_never_logs_its_value(self):
        # This text is echoed verbatim into every .md/.html export - the same constraint the
        # actions already follow.
        condition = interception.Condition(
            {'subject': 'REQUEST_HEADER', 'name': 'authorization', 'operator': 'EQUALS', 'value': 'Bearer hunter2'})
        self.assertNotIn('hunter2', condition.describe())
        self.assertIn('authorization', condition.describe())


class DisabledActionTest(unittest.TestCase):
    """An action with `enabled: false` - kept in the rule, skipped by the engine.

    `_prepare_actions` drops it at load time, the same way it already drops an action with no
    type - so nothing downstream (apply_request/apply_response/a conditional's branches) has to
    know disabling exists at all.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def test_a_disabled_action_never_runs(self):
        verdict = run(self.engine([
            {'type': 'DELAY_REQUEST', 'durationMs': 5000, 'enabled': False},
        ]).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, 0)

    def test_an_action_with_no_enabled_field_still_runs(self):
        # Every rule saved before this feature existed, and every action a proxy this old is
        # handed by an older backend export - enabled is something you turn OFF, not on.
        verdict = run(self.engine([{'type': 'DELAY_REQUEST', 'durationMs': 5000}]).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, 5000)

    def test_enabled_true_runs_exactly_like_absent(self):
        verdict = run(self.engine([
            {'type': 'DELAY_REQUEST', 'durationMs': 5000, 'enabled': True},
        ]).apply_request(FakeFlow()))
        self.assertEqual(verdict.delay_ms, 5000)

    def test_a_disabled_action_next_to_an_enabled_one_only_skips_the_disabled_one(self):
        flow = FakeFlow(FakeRequest(headers={}))
        run(self.engine([
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-Off', 'value': 'nope', 'enabled': False},
            {'type': 'SET_REQUEST_HEADER', 'name': 'X-On', 'value': 'yes'},
        ]).apply_request(flow))
        self.assertNotIn('X-Off', flow.request.headers)
        self.assertEqual(flow.request.headers['X-On'], 'yes')

    def test_disabling_an_if_disables_everything_inside_it_branches_and_all(self):
        # The whole point of one flag rather than a separate toggle per nested action: turning the
        # condition off has to behave exactly like the condition was never in the rule.
        flow = FakeFlow(FakeRequest(headers={}))
        run(self.engine([{
            'type': 'IF_REQUEST',
            'enabled': False,
            'branches': [{
                'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
                'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'yes'}],
            }],
            'otherwise': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Else', 'value': 'yes'}],
        }]).apply_request(flow))
        self.assertNotIn('X-Branch', flow.request.headers)
        self.assertNotIn('X-Else', flow.request.headers)

    def test_a_disabled_action_inside_an_enabled_ifs_branch_is_still_individually_skipped(self):
        flow = FakeFlow(FakeRequest(headers={}))
        run(self.engine([{
            'type': 'IF_REQUEST',
            'branches': [{
                'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
                'actions': [
                    {'type': 'SET_REQUEST_HEADER', 'name': 'X-Off', 'value': 'nope', 'enabled': False},
                    {'type': 'SET_REQUEST_HEADER', 'name': 'X-On', 'value': 'yes'},
                ],
            }],
        }]).apply_request(flow))
        self.assertNotIn('X-Off', flow.request.headers)
        self.assertEqual(flow.request.headers['X-On'], 'yes')


class ConditionalActionTest(unittest.TestCase):
    """The if / else-if / else step itself: which branch runs, and what the log says about it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, action):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=[action])]))

    def conditional(self, branches, otherwise=None, kind='IF_REQUEST'):
        action = {'type': kind, 'branches': branches}
        if otherwise is not None:
            action['otherwise'] = otherwise
        return action

    def test_the_first_matching_branch_wins_and_the_rest_are_skipped(self):
        action = self.conditional([
            {'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]},
            {'conditions': [{'subject': 'URL', 'operator': 'CONTAINS', 'value': 'example'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'two'}]},
        ])
        flow = FakeFlow(FakeRequest(method='POST'))
        run(self.engine(action).apply_request(flow))

        self.assertEqual(flow.request.headers['X-Branch'], 'one')

    def test_a_later_branch_runs_when_the_first_does_not_match(self):
        action = self.conditional([
            {'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'DELETE'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]},
            {'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'two'}]},
        ])
        flow = FakeFlow(FakeRequest(method='POST'))
        run(self.engine(action).apply_request(flow))

        self.assertEqual(flow.request.headers['X-Branch'], 'two')

    def test_the_else_runs_when_nothing_matched(self):
        action = self.conditional(
            [{'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'DELETE'}],
              'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]}],
            otherwise=[{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'else'}])
        flow = FakeFlow(FakeRequest(method='POST'))
        run(self.engine(action).apply_request(flow))

        self.assertEqual(flow.request.headers['X-Branch'], 'else')

    def test_nothing_happens_when_nothing_matched_and_there_is_no_else(self):
        action = self.conditional([{'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'DELETE'}],
                                    'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]}])
        flow = FakeFlow(FakeRequest(method='POST'))
        verdict = run(self.engine(action).apply_request(flow))

        self.assertNotIn('X-Branch', flow.request.headers)
        self.assertEqual(verdict.applied[0].detail, 'no branch matched')

    def test_all_conditions_must_hold_by_default(self):
        action = self.conditional([{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'},
                           {'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'EXISTS'}],
            'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]}])
        flow = FakeFlow(FakeRequest(method='POST'))
        run(self.engine(action).apply_request(flow))

        self.assertNotIn('X-Branch', flow.request.headers)

    def test_any_needs_only_one(self):
        action = self.conditional([{
            'combine': 'ANY',
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'},
                           {'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'EXISTS'}],
            'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]}])
        flow = FakeFlow(FakeRequest(method='POST'))
        run(self.engine(action).apply_request(flow))

        self.assertEqual(flow.request.headers['X-Branch'], 'one')

    def test_a_branch_with_no_conditions_never_matches(self):
        # The backend rejects one; a hand-edited file must not get a free "always" that swallows
        # every branch below it.
        action = self.conditional([{'conditions': [],
                                    'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Branch', 'value': 'one'}]}])
        flow = FakeFlow(FakeRequest())
        run(self.engine(action).apply_request(flow))

        self.assertNotIn('X-Branch', flow.request.headers)

    def test_a_terminal_inside_a_branch_ends_the_phase(self):
        action = self.conditional([{
            'conditions': [{'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'NOT_EXISTS'}],
            'actions': [{'type': 'MOCK_RESPONSE', 'status': 401, 'body': 'no key'},
                        {'type': 'SET_REQUEST_HEADER', 'name': 'X-Never', 'value': '1'}]}])
        flow = FakeFlow(FakeRequest())
        verdict = run(self.engine(action).apply_request(flow))

        self.assertEqual(verdict.terminal, 'MOCK_RESPONSE')
        self.assertEqual(verdict.mock['status'], 401)
        self.assertNotIn('X-Never', flow.request.headers)

    def test_a_pause_inside_a_branch_still_pauses(self):
        action = self.conditional([{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
            'actions': [{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 5}]}])
        verdict = run(self.engine(action).apply_request(FakeFlow(FakeRequest())))

        self.assertIsNotNone(verdict.pause)
        self.assertEqual(verdict.pause['phase'], 'request')

    def test_a_response_action_inside_a_request_conditional_is_skipped(self):
        action = self.conditional([{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
            'actions': [{'type': 'SET_RESPONSE_STATUS', 'status': 500}]}])
        flow = FakeFlow(FakeRequest(), FakeMessage(status=200, text=''))
        run(self.engine(action).apply_request(flow))

        self.assertEqual(flow.response.status_code, 200)

    def test_a_conditional_on_the_response_can_read_the_request_too(self):
        # The main reason to have conditions at all: "if we sent X and got back Y".
        action = self.conditional([{
            'conditions': [{'subject': 'RESPONSE_STATUS', 'operator': 'AT_LEAST', 'value': '500'},
                           {'subject': 'REQUEST_HEADER', 'name': 'x-env', 'operator': 'EQUALS', 'value': 'test'}],
            'actions': [{'type': 'SET_RESPONSE_STATUS', 'status': 200}]}], kind='IF_RESPONSE')
        flow = FakeFlow(FakeRequest(headers={'X-Env': 'test'}), FakeMessage(status=503, text='{}'))
        run(self.engine(action).apply_response(flow))

        self.assertEqual(flow.response.status_code, 200)

    def test_nesting_one_condition_inside_another(self):
        inner = self.conditional([{
            'conditions': [{'subject': 'REQUEST_HEADER', 'name': 'x-env', 'operator': 'EQUALS', 'value': 'test'}],
            'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Deep', 'value': 'yes'}]}])
        outer = self.conditional([{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'}],
            'actions': [inner]}])
        flow = FakeFlow(FakeRequest(method='POST', headers={'X-Env': 'test'}))
        run(self.engine(outer).apply_request(flow))

        self.assertEqual(flow.request.headers['X-Deep'], 'yes')

    def test_the_log_says_which_branch_ran_and_why(self):
        # A rule that can take three paths is only useful if the log says which it took.
        action = self.conditional([
            {'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'DELETE'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-B', 'value': '1'}]},
            {'conditions': [{'subject': 'REQUEST_HEADER', 'name': 'x-api-key', 'operator': 'NOT_EXISTS'}],
             'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-B', 'value': '2'}]},
        ])
        verdict = run(self.engine(action).apply_request(FakeFlow(FakeRequest())))
        applied = verdict.as_log()['applied']

        self.assertEqual(applied[0]['action'], 'IF_REQUEST')
        self.assertIn('branch 2 matched', applied[0]['detail'])
        self.assertIn('request header x-api-key not exists', applied[0]['detail'])
        # The action the branch ran is recorded too, so the trace is complete.
        self.assertEqual(applied[1]['action'], 'SET_REQUEST_HEADER')

    def test_a_branch_that_changes_something_still_gets_a_before_and_after(self):
        # Capture is generic: it snapshots the phase, so a change made inside a branch needs no
        # code of its own to be recorded.
        action = self.conditional([{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
            'actions': [{'type': 'SET_REQUEST_JSON_FIELD', 'path': 'a', 'value': 2}]}])
        flow = FakeFlow(FakeRequest(text=json.dumps({'a': 1})))
        verdict = run(self.engine(action).apply_request(flow))
        verdict.finalize_request(flow)

        self.assertEqual(json.loads(verdict.original_request['body']), {'a': 1})
        self.assertEqual(json.loads(verdict.final_request['body']), {'a': 2})


class EveryActionIsCoveredTest(unittest.TestCase):
    """Walks the action sets themselves, so adding an action to REQUEST_ACTIONS or
    RESPONSE_ACTIONS and forgetting about its before/after is a failing build rather than a
    feature that silently records nothing.

    Capture is generic - the engine snapshots each phase on both sides and compares - so the
    point is not to re-prove each action individually but to guarantee that the generic path is
    really exercised by every action there is, including ones added after this was written.
    """

    # Actions that deliberately record no before/after, with the reason. Anything NOT listed here
    # must produce both ends.
    NO_CHANGE = {
        'DELAY_REQUEST': 'changes when, not what',
        'DELAY_RESPONSE': 'changes when, not what',
        'SEND_TO_HOST': 'forwarding already happens; it only refuses a later short-circuit',
        'ABORT_REQUEST': 'nothing is sent and nothing comes back',
        'PAUSE_REQUEST': 'the pause changes nothing - the human decision might',
        'PAUSE_RESPONSE': 'the pause changes nothing - the human decision might',
    }

    # One action of each type that really does change something, against the fixture below.
    SAMPLES = {
        'SET_REQUEST_HEADER': {'type': 'SET_REQUEST_HEADER', 'name': 'X-A', 'value': '1'},
        'REMOVE_REQUEST_HEADER': {'type': 'REMOVE_REQUEST_HEADER', 'name': 'X-Gone'},
        'SET_QUERY_PARAM': {'type': 'SET_QUERY_PARAM', 'name': 'q', 'value': '2'},
        'REMOVE_QUERY_PARAM': {'type': 'REMOVE_QUERY_PARAM', 'name': 'drop'},
        'SET_REQUEST_JSON_FIELD': {'type': 'SET_REQUEST_JSON_FIELD', 'path': 'a', 'value': 9},
        'REPLACE_IN_REQUEST_BODY': {'type': 'REPLACE_IN_REQUEST_BODY', 'pattern': '1', 'replacement': '2'},
        'REWRITE_URL': {'type': 'REWRITE_URL', 'target': {'path': '/elsewhere'}},
        'SET_METHOD': {'type': 'SET_METHOD', 'method': 'PUT'},
        'REMOVE_REQUEST_JSON_FIELD': {'type': 'REMOVE_REQUEST_JSON_FIELD', 'path': 'a'},
        'SET_REQUEST_BODY': {'type': 'SET_REQUEST_BODY', 'body': 'replaced'},
        'MOCK_RESPONSE': {'type': 'MOCK_RESPONSE', 'status': 418, 'body': 'teapot'},
        # The mode that answers rather than kills, so there is something to record either end of.
        'SIMULATE_FAILURE': {'type': 'SIMULATE_FAILURE', 'failure': 'GATEWAY_ERROR', 'status': 503},
        # A branch that matches the fixture and changes something, so the generic before/after
        # capture has both ends to record.
        'IF_REQUEST': {'type': 'IF_REQUEST', 'branches': [{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
            'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-A', 'value': '1'}]}]},
        'IF_RESPONSE': {'type': 'IF_RESPONSE', 'branches': [{
            'conditions': [{'subject': 'RESPONSE_STATUS', 'operator': 'EQUALS', 'value': '200'}],
            'actions': [{'type': 'SET_RESPONSE_HEADER', 'name': 'X-A', 'value': '1'}]}]},
        'SET_RESPONSE_STATUS': {'type': 'SET_RESPONSE_STATUS', 'status': 500},
        'SET_RESPONSE_HEADER': {'type': 'SET_RESPONSE_HEADER', 'name': 'X-A', 'value': '1'},
        'REMOVE_RESPONSE_HEADER': {'type': 'REMOVE_RESPONSE_HEADER', 'name': 'X-Gone'},
        'SET_RESPONSE_JSON_FIELD': {'type': 'SET_RESPONSE_JSON_FIELD', 'path': 'a', 'value': 9},
        'SET_RESPONSE_BODY': {'type': 'SET_RESPONSE_BODY', 'body': 'replaced'},
        'REPLACE_IN_RESPONSE_BODY': {'type': 'REPLACE_IN_RESPONSE_BODY', 'pattern': '1', 'replacement': '2'},
        'REMOVE_RESPONSE_JSON_FIELD': {'type': 'REMOVE_RESPONSE_JSON_FIELD', 'path': 'a'},
        'REPLACE_RESPONSE': {'type': 'REPLACE_RESPONSE', 'status': 503, 'body': 'nope'},
        'DELAY_REQUEST': {'type': 'DELAY_REQUEST', 'durationMs': 1},
        'DELAY_RESPONSE': {'type': 'DELAY_RESPONSE', 'durationMs': 1},
        'SEND_TO_HOST': {'type': 'SEND_TO_HOST'},
        'ABORT_REQUEST': {'type': 'ABORT_REQUEST'},
        'PAUSE_REQUEST': {'type': 'PAUSE_REQUEST', 'timeoutSeconds': 1},
        'PAUSE_RESPONSE': {'type': 'PAUSE_RESPONSE', 'timeoutSeconds': 1},
    }

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def flow(self, phase):
        # No response during the REQUEST phase, as in a real flow - mitmproxy has not called
        # upstream yet. It matters: a response that exists when the request phase ends is how
        # finalize_request knows one was manufactured.
        return FakeFlow(
            FakeRequest(text=json.dumps({'a': 1}), headers={'X-Gone': 'x'}, query={'drop': '1'}),
            None if phase == 'request'
            else FakeMessage(status=200, text=json.dumps({'a': 1}), headers={'X-Gone': 'x'}))

    def test_every_action_type_has_a_sample(self):
        every = interception.REQUEST_ACTIONS | interception.RESPONSE_ACTIONS
        self.assertEqual(
            every - set(self.SAMPLES), set(),
            'a new action type needs an entry in SAMPLES - and in NO_CHANGE if it genuinely '
            'changes nothing observable')

    def test_every_action_that_changes_something_records_both_ends(self):
        for kind, action in sorted(self.SAMPLES.items()):
            with self.subTest(action=kind):
                phase = 'request' if kind in interception.REQUEST_ACTIONS else 'response'
                flow = self.flow(phase)
                engine = interception.InterceptionEngine(
                    'outbound', write_rules(self.tmp.name, [rule(id=kind, actions=[action])]))

                if phase == 'request':
                    verdict = run(engine.apply_request(flow))
                    if verdict.terminal == 'MOCK_RESPONSE':
                        # What the addon does with the verdict, so the mock is a real response by
                        # the time the phase is finalized.
                        flow.response = FakeMessage(status=verdict.mock['status'], text=verdict.mock['body'])
                    elif verdict.terminal == 'SIMULATE_FAILURE':
                        spec = interception.failure_plan(verdict.failure)['response']
                        if spec:
                            flow.response = FakeMessage(status=spec['status'], text=spec['body'])
                    verdict.finalize_request(flow)
                    recorded = verdict.original_request is not None or verdict.final_response is not None
                else:
                    verdict = run(engine.apply_response(flow))
                    verdict.finalize_response(flow)
                    recorded = verdict.original_response is not None

                if kind in self.NO_CHANGE:
                    self.assertFalse(
                        recorded, f'{kind} {self.NO_CHANGE[kind]}, so it should record neither end')
                    continue

                self.assertTrue(recorded, f'{kind} changed the call but recorded no before/after')
                # Whatever is recorded must be recorded in full - one end without the other is a
                # diff the UI cannot draw.
                log = verdict.as_log()
                if 'originalRequest' in log:
                    self.assertIn('finalRequest', log)
                if 'originalResponse' in log:
                    self.assertIn('finalResponse', log)


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


class FollowTest(unittest.TestCase):
    """Following a call past the half it was paused on.

    The two facts note_decision records are deliberately separate, and these pin that apart: a
    CARD is left by any decision a person made, because not closing the moment you press Send is
    the whole point; stopping a SECOND time is only what they ticked.
    """

    PAUSE = {'phase': 'request', 'ruleId': 'r1', 'ruleName': 'all intercept',
             'timeoutSeconds': 45, 'onTimeout': 'abort'}

    def test_any_human_decision_leaves_a_card(self):
        flow = FakeFlow()
        interception.note_decision(flow, 'request', self.PAUSE, {'action': 'release'})
        self.assertTrue(flow.metadata.get(interception.CARD_KEY))

    def test_a_decision_made_by_the_clock_leaves_nothing(self):
        # A rule that pauses everything times out dozens of calls nobody looked at; a card for
        # each would bury the one being worked on.
        for reason in ('timeout', 'backend-unreachable', 'not-registered'):
            flow = FakeFlow()
            interception.note_decision(flow, 'request', self.PAUSE,
                                       {'action': 'release', 'reason': reason})
            self.assertFalse(flow.metadata.get(interception.CARD_KEY), reason)
            self.assertIsNone(interception.follow_pause(flow), reason)

    def test_a_card_alone_does_not_stop_the_call_again(self):
        flow = FakeFlow()
        interception.note_decision(flow, 'request', self.PAUSE, {'action': 'release'})
        self.assertIsNone(interception.follow_pause(flow))

    def test_following_stops_the_response_half_with_the_rules_own_timeout(self):
        flow = FakeFlow()
        interception.note_decision(flow, 'request', self.PAUSE, {'action': 'release', 'follow': True})

        spec = interception.follow_pause(flow)

        self.assertEqual(spec['phase'], 'response')
        # Inherited, so following a call does not silently give it a different grace period from
        # the rule that stopped it in the first place.
        self.assertEqual(spec['timeoutSeconds'], 45)
        self.assertEqual(spec['onTimeout'], 'abort')
        self.assertEqual(spec['ruleName'], 'all intercept')

    def test_a_pause_spec_with_nothing_in_it_still_gets_a_deadline(self):
        # A pause with no timeout could hold a caller with no way out. Validation rejects one, but
        # this is the request path and it does not get to assume validation ran.
        flow = FakeFlow()
        interception.note_decision(flow, 'request', {}, {'action': 'release', 'follow': True})

        spec = interception.follow_pause(flow)

        self.assertGreater(spec['timeoutSeconds'], 0)
        self.assertEqual(spec['onTimeout'], 'release')

    def test_aborting_never_follows_because_there_is_nothing_to_follow(self):
        flow = FakeFlow()
        interception.note_decision(flow, 'request', self.PAUSE, {'action': 'abort', 'follow': True})
        self.assertIsNone(interception.follow_pause(flow))

    def test_a_response_decision_never_asks_for_another_stop(self):
        # There is no third half. Ticking follow on a response pause must not loop.
        flow = FakeFlow()
        interception.note_decision(flow, 'response', self.PAUSE, {'action': 'release', 'follow': True})
        self.assertIsNone(interception.follow_pause(flow))

    def test_a_call_nobody_paused_is_never_followed(self):
        self.assertIsNone(interception.follow_pause(FakeFlow()))


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


class BreakpointPollPoolTest(unittest.IsolatedAsyncioTestCase):
    """The long poll must not share a thread pool with the short messages.

    asyncio's default executor is min(32, cpu_count + 4) threads - 20 on the machine this was
    measured on - and a poll occupies one of them for its whole window, continuously, per paused
    call. Sharing it means that past about twenty simultaneous pauses, registering a NEW pause and
    reporting a finished one queue behind polls, so the inspector stops reflecting reality exactly
    when it matters most.
    """

    def setUp(self):
        self._real_post = breakpoints._post
        self._real_get = breakpoints._get
        self._real_backend = breakpoints.BACKEND
        breakpoints.BACKEND = 'http://backend.test'
        self.addCleanup(self._restore)

    def _restore(self):
        breakpoints._post = self._real_post
        breakpoints._get = self._real_get
        breakpoints.BACKEND = self._real_backend

    @staticmethod
    def _pause(timeout=5):
        return {'phase': 'response', 'timeoutSeconds': timeout, 'onTimeout': 'release',
                'ruleId': 'r', 'ruleName': 'Rule'}

    async def test_the_poll_runs_on_the_dedicated_pool_and_registering_does_not(self):
        polled_on = []
        registered_on = []

        def record_get(path, timeout):
            polled_on.append(threading.current_thread().name)
            return {'action': 'release'}

        def record_post(path, payload, timeout):
            registered_on.append(threading.current_thread().name)
            return None

        breakpoints._get = record_get
        breakpoints._post = record_post

        await breakpoints.wait_for_decision(
            FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}')),
            'response', 'c1', self._pause(), 'outbound', None)

        self.assertTrue(polled_on, 'the poll never ran')
        self.assertTrue(all(name.startswith('alfred-breakpoint-poll') for name in polled_on), polled_on)
        self.assertTrue(registered_on, 'the registration never ran')
        self.assertFalse(any(name.startswith('alfred-breakpoint-poll') for name in registered_on),
                         f'registering a pause belongs on the shared pool, ran on {registered_on}')

    async def test_more_calls_can_poll_at_once_than_the_default_executor_would_allow(self):
        # Comfortably more than min(32, cpu_count + 4), so this cannot pass on the shared pool.
        target = 40
        state = {'inside': 0, 'peak': 0}
        lock = threading.Lock()
        enough = threading.Event()

        def blocking_get(path, timeout):
            with lock:
                state['inside'] += 1
                state['peak'] = max(state['peak'], state['inside'])
                if state['peak'] >= target:
                    enough.set()
            # Held until every poll is genuinely in flight at the same time - bounded, so a pool
            # too small to get there fails the assertion below instead of hanging the suite.
            enough.wait(5)
            with lock:
                state['inside'] -= 1
            return {'action': 'release'}

        breakpoints._get = blocking_get
        breakpoints._post = lambda *a, **k: None

        await asyncio.gather(*[
            breakpoints.wait_for_decision(
                FakeFlow(FakeRequest(), FakeMessage(status=200, text='{}')),
                'response', f'c{i}', self._pause(), 'outbound', None)
            for i in range(target)])

        self.assertGreaterEqual(state['peak'], target,
                                f'only {state["peak"]} polls were ever in flight at once')


class SecretMaskingTest(unittest.TestCase):
    """The interception record is echoed verbatim into the call log and every export, so a secret
    must never reach it - not in an action's detail, and not in the before/after snapshots.

    Both of these leaked before: the snapshots copied headers as-is, and SET_QUERY_PARAM recorded
    name=value for any name. A rule that set `api_key=...` put the key in every export."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions, **extra):
        return interception.InterceptionEngine(
            'outbound', write_rules(self.tmp.name, [rule(actions=actions)], **extra))

    def test_a_secret_header_in_the_before_and_after_is_masked(self):
        flow = FakeFlow(FakeRequest(headers={'Authorization': 'Bearer abc123', 'X-Trace': 't1'}))
        verdict = run(self.engine([{'type': 'SET_REQUEST_HEADER', 'name': 'X-Trace', 'value': 't2'}])
                      .apply_request(flow))
        verdict.finalize_request(flow)
        log = verdict.as_log()
        self.assertEqual(log['originalRequest']['headers']['Authorization'], '(value not logged · 13 chars)')
        self.assertEqual(log['finalRequest']['headers']['Authorization'], '(value not logged · 13 chars)')
        self.assertEqual(log['finalRequest']['headers']['X-Trace'], 't2')
        self.assertNotIn('abc123', json.dumps(log))

    def test_a_secret_swapped_for_one_of_the_same_length_still_counts_as_a_change(self):
        # Masking is applied on the way out, never to the working snapshots - otherwise two
        # different tokens of equal length would compare equal and the before/after would vanish.
        flow = FakeFlow(FakeRequest(headers={'Authorization': 'Bearer aaaaaa'}))
        verdict = run(self.engine([{'type': 'SET_REQUEST_HEADER', 'name': 'Authorization',
                                    'value': 'Bearer bbbbbb'}]).apply_request(flow))
        verdict.finalize_request(flow)
        self.assertIsNotNone(verdict.original_request)
        self.assertNotIn('bbbbbb', json.dumps(verdict.as_log()))

    def test_a_secret_query_parameter_value_is_not_recorded(self):
        verdict = run(self.engine([{'type': 'SET_QUERY_PARAM', 'name': 'api-key', 'value': 'secret'}])
                      .apply_request(FakeFlow()))
        detail = verdict.applied[0].detail
        self.assertNotIn('secret', detail)
        self.assertIn('api-key', detail)

    def test_an_ordinary_query_parameter_still_shows_its_value(self):
        verdict = run(self.engine([{'type': 'SET_QUERY_PARAM', 'name': 'mode', 'value': 'sandbox'}])
                      .apply_request(FakeFlow()))
        self.assertEqual(verdict.applied[0].detail, 'mode=sandbox')

    def test_the_published_list_replaces_the_built_in_one(self):
        # backend-interception owns the list; a name only it knows about is masked too.
        flow = FakeFlow(FakeRequest(headers={'X-Tenant-Secret': 'topsecret'}))
        engine = self.engine([{'type': 'SET_REQUEST_HEADER', 'name': 'X-Other', 'value': '1'}],
                             sensitiveHeaders=['x-tenant-secret'])
        verdict = run(engine.apply_request(flow))
        verdict.finalize_request(flow)
        self.assertNotIn('topsecret', json.dumps(verdict.as_log()))


class SkipRecordTest(unittest.TestCase):
    """An action that ran and changed nothing is recorded as skipped, with the reason. A rule that
    "did nothing" and a rule that never matched otherwise look identical in the log."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def details(self, actions, flow, phase='request'):
        engine = interception.InterceptionEngine('outbound', write_rules(self.tmp.name, [rule(actions=actions)]))
        verdict = run(engine.apply_request(flow) if phase == 'request' else engine.apply_response(flow))
        return [(a.action, a.detail) for a in verdict.applied]

    def test_removing_a_header_that_is_not_there_is_recorded(self):
        self.assertEqual(self.details([{'type': 'REMOVE_REQUEST_HEADER', 'name': 'X-Gone'}], FakeFlow()),
                         [('REMOVE_REQUEST_HEADER', 'skipped - no such header')])

    def test_removing_a_query_parameter_that_is_not_there_is_recorded(self):
        self.assertEqual(self.details([{'type': 'REMOVE_QUERY_PARAM', 'name': 'drop'}], FakeFlow()),
                         [('REMOVE_QUERY_PARAM', 'skipped - no such parameter')])

    def test_a_json_path_that_is_not_there_is_recorded(self):
        flow = FakeFlow(FakeRequest(text='{"a":1}'))
        self.assertEqual(self.details([{'type': 'SET_REQUEST_JSON_FIELD', 'path': 'b.c', 'value': 1}], flow),
                         [('SET_REQUEST_JSON_FIELD', 'skipped - path not found')])

    def test_a_response_header_that_is_not_there_is_recorded(self):
        flow = FakeFlow(response=FakeMessage(text='', status=200))
        self.assertEqual(self.details([{'type': 'REMOVE_RESPONSE_HEADER', 'name': 'X-Gone'}], flow, 'response'),
                         [('REMOVE_RESPONSE_HEADER', 'skipped - no such header')])

    def test_an_action_this_proxy_does_not_know_is_recorded_not_ignored(self):
        # A rules file newer than the proxy reading it (a partial deploy) must say so in the log.
        self.assertEqual(self.details([{'type': 'FROM_THE_FUTURE'}], FakeFlow()),
                         [('FROM_THE_FUTURE', 'skipped - unknown action FROM_THE_FUTURE')])

    def test_an_unknown_action_inside_a_branch_is_recorded_too(self):
        actions = [{'type': 'IF_REQUEST', 'branches': [{
            'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'GET'}],
            'actions': [{'type': 'FROM_THE_FUTURE'}]}]}]
        details = self.details(actions, FakeFlow())
        self.assertIn(('FROM_THE_FUTURE', 'skipped - unknown action FROM_THE_FUTURE'), details)

    def test_an_action_of_the_other_phase_stays_silent(self):
        # A response action in the request phase is simply not this phase's business - it runs
        # later, so it must not be reported as skipped here.
        self.assertEqual(self.details([{'type': 'SET_RESPONSE_STATUS', 'status': 500}], FakeFlow()), [])


class EncodedMessage(FakeMessage):
    """A body with a Content-Encoding, standing in for mitmproxy's: reading .text decodes, and
    assigning .text re-encodes with the same encoding. The engine must go through that setter -
    writing raw bytes would put plain text under a `content-encoding: gzip` header, which the
    client then fails to decode."""

    def __init__(self, text, encoding='gzip', **kwargs):
        FakeMessage.__init__(self, text=None, **kwargs)
        self.headers['content-encoding'] = encoding
        self._text = text
        self.reencoded_with = None

    @property
    def text(self):
        return self._text

    @text.setter
    def text(self, value):
        self._text = value
        # FakeMessage.__init__ assigns .text before it has set headers up.
        headers = getattr(self, 'headers', None)
        self.reencoded_with = headers.get('content-encoding') if headers is not None else None

    def get_text(self, strict=True):
        return self._text


class ReplaceInBodyTest(unittest.TestCase):
    """Find and replace in a body of any content type - the edit a SOAP or plain-text supplier
    payload needs, which no JSON path can reach."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, actions):
        return interception.InterceptionEngine('outbound', write_rules(self.tmp.name, [rule(actions=actions)]))

    def replace(self, text, phase='response', **fields):
        action = {'type': 'REPLACE_IN_RESPONSE_BODY' if phase == 'response' else 'REPLACE_IN_REQUEST_BODY', **fields}
        engine = self.engine([action])
        if phase == 'response':
            flow = FakeFlow(response=FakeMessage(text=text, status=200))
            verdict = run(engine.apply_response(flow))
            return flow.response, verdict
        flow = FakeFlow(FakeRequest(text=text))
        verdict = run(engine.apply_request(flow))
        return flow.request, verdict

    def test_a_literal_replaces_every_occurrence(self):
        message, verdict = self.replace('<Cur>EUR</Cur><Cur>EUR</Cur><Cur>EUR</Cur>', pattern='EUR', replacement='USD')
        self.assertEqual(message.text, '<Cur>USD</Cur><Cur>USD</Cur><Cur>USD</Cur>')
        self.assertEqual(verdict.applied[0].detail, '3 replacements')

    def test_the_limit_stops_after_that_many(self):
        message, _ = self.replace('EUR EUR EUR', pattern='EUR', replacement='USD', maxReplacements=1)
        self.assertEqual(message.text, 'USD EUR EUR')

    def test_matching_can_ignore_case(self):
        message, _ = self.replace('eur Eur EUR', pattern='EUR', replacement='USD', caseSensitive=False)
        self.assertEqual(message.text, 'USD USD USD')

    def test_a_literal_with_regex_characters_matches_as_text(self):
        message, _ = self.replace('price $10.00 (net)', pattern='$10.00 (net)', replacement='$0')
        self.assertEqual(message.text, 'price $0')

    def test_a_case_insensitive_literal_replacement_is_not_read_as_a_group_reference(self):
        message, _ = self.replace('abc', pattern='B', replacement='\\1', caseSensitive=False)
        self.assertEqual(message.text, 'a\\1c')

    def test_a_regex_can_reuse_what_it_matched(self):
        message, _ = self.replace('<Id>42</Id>', pattern='<Id>(\\d+)</Id>', replacement='<Id>X\\1</Id>', regex=True)
        self.assertEqual(message.text, '<Id>X42</Id>')

    def test_no_match_leaves_the_body_untouched_and_says_so(self):
        original = '{"currency":"GBP"}'
        message, verdict = self.replace(original, pattern='EUR', replacement='USD')
        self.assertIs(message.text, original)
        self.assertEqual(verdict.applied[0].detail, 'skipped - no match')

    def test_a_request_body_is_edited_too(self):
        message, verdict = self.replace('token=abc', phase='request', pattern='abc', replacement='xyz')
        self.assertEqual(message.text, 'token=xyz')
        self.assertEqual(verdict.applied[0].action, 'REPLACE_IN_REQUEST_BODY')

    def test_a_streamed_body_is_skipped_rather_than_half_edited(self):
        engine = self.engine([{'type': 'REPLACE_IN_RESPONSE_BODY', 'pattern': 'a', 'replacement': 'b'}])
        response = FakeMessage(text='aaa', status=200)
        response.stream = True
        verdict = run(engine.apply_response(FakeFlow(response=response)))
        self.assertEqual(response.text, 'aaa')
        self.assertEqual(verdict.applied[0].detail, 'skipped - body was streamed, not buffered')

    def test_a_regex_that_times_out_is_skipped_and_leaves_the_body_alone(self):
        async def timed_out(*args, **kwargs):
            return None, 0, True
        original = interception.regex_worker.sub
        interception.regex_worker.sub = timed_out
        self.addCleanup(setattr, interception.regex_worker, 'sub', original)
        message, verdict = self.replace('aaaa', pattern='(a+)+$', replacement='x', regex=True)
        self.assertEqual(message.text, 'aaaa')
        self.assertTrue(verdict.applied[0].detail.startswith('skipped - pattern timed out after'))

    def test_a_compressed_body_is_written_back_through_the_re_encoding_setter(self):
        engine = self.engine([{'type': 'REPLACE_IN_RESPONSE_BODY', 'pattern': 'EUR', 'replacement': 'USD'}])
        response = EncodedMessage('{"c":"EUR"}', encoding='gzip', status=200)
        run(engine.apply_response(FakeFlow(response=response)))
        self.assertEqual(response.text, '{"c":"USD"}')
        self.assertEqual(response.reencoded_with, 'gzip')

    def test_a_large_body_is_replaced_in_full(self):
        # SC-006: a real supplier payload is megabytes, and the edit must reach the very end of it.
        body = '<Seg><Cur>EUR</Cur></Seg>' * 200_000  # ~5 MB
        message, verdict = self.replace(body, pattern='EUR', replacement='USD')
        self.assertEqual(message.text.count('USD'), 200_000)
        self.assertNotIn('EUR', message.text)
        self.assertEqual(verdict.applied[0].detail, '200000 replacements')

    def test_it_works_inside_a_branch(self):
        # FR-014: a new action is an action like any other inside IF_RESPONSE.
        engine = self.engine([{'type': 'IF_RESPONSE', 'branches': [{
            'conditions': [{'subject': 'RESPONSE_STATUS', 'operator': 'EQUALS', 'value': '200'}],
            'actions': [{'type': 'REPLACE_IN_RESPONSE_BODY', 'pattern': 'EUR', 'replacement': 'USD'}]}]}])
        flow = FakeFlow(response=FakeMessage(text='EUR', status=200))
        run(engine.apply_response(flow))
        self.assertEqual(flow.response.text, 'USD')
        flow = FakeFlow(response=FakeMessage(text='EUR', status=500))
        run(engine.apply_response(flow))
        self.assertEqual(flow.response.text, 'EUR')


class RewriteUrlTest(unittest.TestCase):
    """REWRITE_URL sends a call somewhere else - the staging supplier instead of production, a
    different port, a newer path version - without touching the application under test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def rewrite(self, request, **fields):
        engine = interception.InterceptionEngine('outbound', write_rules(
            self.tmp.name, [rule(actions=[{'type': 'REWRITE_URL', **fields}])],
            selfTargets=['backend', 'localhost:5000']))
        return run(engine.apply_request(FakeFlow(request)))

    def test_a_host_swap_reaches_the_new_host_and_the_host_header_follows(self):
        request = UrlRequest(headers={'Host': 'api.supplier.com'})
        verdict = self.rewrite(request, target={'host': 'staging.supplier.com'})
        self.assertEqual(request.url, 'https://staging.supplier.com/v1/fares?mode=live')
        self.assertEqual(request.headers['Host'], 'staging.supplier.com')
        self.assertIn('api.supplier.com', verdict.applied[0].detail)
        self.assertIn('staging.supplier.com', verdict.applied[0].detail)

    def test_keeping_the_host_header_sends_the_original_one(self):
        request = UrlRequest(headers={'Host': 'api.supplier.com'})
        self.rewrite(request, target={'host': 'staging.supplier.com'}, keepHostHeader=True)
        self.assertEqual(request.host, 'staging.supplier.com')
        self.assertEqual(request.headers['Host'], 'api.supplier.com')

    def test_a_path_rewrite_keeps_scheme_host_port_and_query(self):
        request = UrlRequest('http://api.supplier.com:8081/v1/fares?mode=live')
        self.rewrite(request, target={'path': '/v2/fares'})
        self.assertEqual(request.url, 'http://api.supplier.com:8081/v2/fares?mode=live')

    def test_a_pattern_rewrites_just_what_it_matches(self):
        request = UrlRequest()
        self.rewrite(request, pattern='/v1/', replacement='/v2/')
        self.assertEqual(request.url, 'https://api.supplier.com/v2/fares?mode=live')

    def test_a_rewrite_into_alfred_is_refused_at_run_time(self):
        # A pattern's result is only known now - the backend could not have refused this one.
        request = UrlRequest('http://api.supplier.com/x')
        verdict = self.rewrite(request, pattern='api.supplier.com', replacement='localhost:5000')
        self.assertEqual(request.url, 'http://api.supplier.com/x')
        self.assertTrue(verdict.applied[0].detail.startswith('refused - target localhost:5000 is Alfred itself'))

    def test_a_pattern_that_matches_nothing_is_recorded(self):
        request = UrlRequest()
        verdict = self.rewrite(request, pattern='/v9/', replacement='/v2/')
        self.assertEqual(verdict.applied[0].detail, 'skipped - no match')

    def test_a_secret_query_value_stays_out_of_the_record(self):
        request = UrlRequest('https://api.supplier.com/x?api-key=s3cret&mode=live')
        verdict = self.rewrite(request, target={'host': 'staging.supplier.com'})
        self.assertNotIn('s3cret', verdict.applied[0].detail)
        self.assertIn('mode=live', verdict.applied[0].detail)


class SetMethodTest(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def set_method(self, method, current='POST'):
        engine = interception.InterceptionEngine('outbound', write_rules(
            self.tmp.name, [rule(actions=[{'type': 'SET_METHOD', 'method': method}])]))
        request = FakeRequest(method=current, text='{"a":1}')
        verdict = run(engine.apply_request(FakeFlow(request)))
        return request, verdict

    def test_the_method_changes_and_the_body_is_kept(self):
        request, verdict = self.set_method('put')
        self.assertEqual(request.method, 'PUT')
        self.assertEqual(request.text, '{"a":1}')
        self.assertEqual(verdict.applied[0].detail, 'POST → PUT')

    def test_setting_the_method_it_already_has_is_recorded_as_skipped(self):
        _, verdict = self.set_method('POST')
        self.assertEqual(verdict.applied[0].detail, 'skipped - already POST')


class RemoveJsonFieldTest(unittest.TestCase):
    """A field that is MISSING, not null - the supplier contract bug the existing actions could
    not produce."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def remove(self, body, path, phase='response'):
        kind = 'REMOVE_RESPONSE_JSON_FIELD' if phase == 'response' else 'REMOVE_REQUEST_JSON_FIELD'
        engine = interception.InterceptionEngine('outbound', write_rules(
            self.tmp.name, [rule(actions=[{'type': kind, 'path': path}])]))
        if phase == 'response':
            flow = FakeFlow(response=FakeMessage(text=body, status=200))
            verdict = run(engine.apply_response(flow))
            return flow.response, verdict
        flow = FakeFlow(FakeRequest(text=body))
        return flow.request, run(engine.apply_request(flow))

    def test_every_segments_cabin_is_removed_and_nothing_else(self):
        body = json.dumps({'segments': [{'id': 1, 'cabin': 'Y'}, {'id': 2, 'cabin': 'J'}, {'id': 3, 'cabin': 'Y'}]})
        message, _ = self.remove(body, 'segments[*].cabin')
        self.assertEqual(json.loads(message.text), {'segments': [{'id': 1}, {'id': 2}, {'id': 3}]})

    def test_an_index_removes_that_element(self):
        message, _ = self.remove(json.dumps({'items': ['a', 'b', 'c']}), 'items[1]')
        self.assertEqual(json.loads(message.text), {'items': ['a', 'c']})

    def test_the_key_is_gone_not_null(self):
        message, _ = self.remove(json.dumps({'itinerary': {'seatsRemaining': 4, 'id': 'X'}}), 'itinerary.seatsRemaining')
        self.assertNotIn('seatsRemaining', json.loads(message.text)['itinerary'])

    def test_a_path_that_is_not_there_leaves_the_body_identical(self):
        body = '{"a": 1}'
        message, verdict = self.remove(body, 'b.c')
        self.assertIs(message.text, body)
        self.assertEqual(verdict.applied[0].detail, 'skipped - path not found')

    def test_a_request_body_field_is_removed_too(self):
        message, verdict = self.remove('{"passengers": 1, "promo": "X"}', 'promo', phase='request')
        self.assertEqual(json.loads(message.text), {'passengers': 1})
        self.assertEqual(verdict.applied[0].action, 'REMOVE_REQUEST_JSON_FIELD')

    def test_a_large_itinerary_keeps_every_other_field(self):
        body = json.dumps({'segments': [{'n': i, 'cabin': 'Y', 'fare': i * 1.5} for i in range(20_000)]})
        message, _ = self.remove(body, 'segments[*].cabin')
        segments = json.loads(message.text)['segments']
        self.assertEqual(len(segments), 20_000)
        self.assertTrue(all('cabin' not in s and 'fare' in s for s in segments))

    def test_it_works_inside_a_branch(self):
        engine = interception.InterceptionEngine('outbound', write_rules(self.tmp.name, [rule(actions=[{
            'type': 'IF_REQUEST', 'branches': [{
                'conditions': [{'subject': 'METHOD', 'operator': 'EQUALS', 'value': 'POST'}],
                'actions': [{'type': 'REMOVE_REQUEST_JSON_FIELD', 'path': 'promo'}]}]}])]))
        flow = FakeFlow(FakeRequest(method='POST', text='{"promo": "X", "a": 1}'))
        run(engine.apply_request(flow))
        self.assertEqual(json.loads(flow.request.text), {'a': 1})


class SetRequestBodyTest(unittest.TestCase):

    def test_the_body_and_its_content_type_are_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = interception.InterceptionEngine('outbound', write_rules(tmp, [rule(actions=[
                {'type': 'SET_REQUEST_BODY', 'body': '<Order/>', 'contentType': 'application/xml'}])]))
            flow = FakeFlow(FakeRequest(text='{"a":1}', headers={'content-type': 'application/json'}))
            verdict = run(engine.apply_request(flow))
            self.assertEqual(flow.request.text, '<Order/>')
            self.assertEqual(flow.request.headers['content-type'], 'application/xml')
            self.assertEqual(verdict.applied[0].detail, '8 chars, application/xml')


if __name__ == '__main__':
    unittest.main()
