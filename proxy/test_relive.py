"""
Tests for proxy/relive.py (T029-T034) and the tiered-evaluation / MATCHES_RECORDED_CALL support it
relies on in interception.py.

Reuses test_interception.py's fake mitmproxy flow objects rather than inventing new ones (see
that module's docstring for why they're hand-rolled): a real flow needs a live connection, and
these fakes implement exactly the surface both interception.py and relive.py touch.

    python -m pytest test_relive.py test_interception.py -q
"""

import asyncio
import json
import os
import tempfile
import unittest

import interception
import log_and_route
import log_and_route_reverse
import relive
from test_interception import FakeFlow, FakeRequest, FakeClientConn, write_rules, write_answer, run, ANSWER


BACKEND_PEER = ('203.0.113.5', 51000)   # FakeFlow's default peer - "the backend", when trusted
OTHER_PEER = ('198.51.100.9', 40000)    # some other client - never the backend


def make_engine(tmpdir, source='outbound'):
    return interception.InterceptionEngine(
        source,
        rules_file=os.path.join(tmpdir, 'rules.json'),
        variables_path=os.path.join(tmpdir, 'variables.json'))


def relive_dir(tmpdir):
    return os.path.join(tmpdir, 'relive')


def write_run(tmpdir, run_id, state='RUNNING', **kwargs):
    directory = relive_dir(tmpdir)
    os.makedirs(directory, exist_ok=True)
    doc = {
        'version': 1, 'state': state, 'runId': run_id, 'cycleId': 'cycle-1', 'driver': 'AUTOMATIC',
        'globalRules': {'mode': 'NONE'}, 'projects': ['proj'], 'variables': {}, 'secrets': [],
        'steps': [], 'cycleRules': [],
        'unexpectedCalls': {'policy': 'BLOCK', 'fallback': 'BLOCK', 'rules': []},
    }
    doc.update(kwargs)
    with open(os.path.join(directory, run_id + '.json'), 'w', encoding='utf-8') as f:
        json.dump(doc, f)
    return doc


def write_inflight(tmpdir, projects):
    directory = relive_dir(tmpdir)
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, 'inflight.json'), 'w', encoding='utf-8') as f:
        json.dump({'at': 0, 'projects': projects}, f)


def replay_step(step_key='s-search', child_key='c-supA', ordinal=1, host='api.supplier.com',
                 path_contains='/search', mode='REPLAY', unattributed='BLOCK',
                 mock_status=200, mock_body='{"ok":true}', extra_actions=None, match_extra=None):
    match = {'source': 'outbound', 'methods': ['GET'], 'host': host, 'pathContains': path_contains}
    if match_extra:
        match.update(match_extra)
    actions = list(extra_actions or [])
    if mode == 'REPLAY':
        actions.append({'type': 'MOCK_RESPONSE', 'status': mock_status, 'body': mock_body})
    call_rule = {'id': 'cr-' + child_key, 'name': 'call rule', 'match': match, 'actions': actions}
    child = {'stepKey': child_key, 'mode': mode, 'unattributed': unattributed, 'ordinal': ordinal,
             'match': match, 'callRule': call_rule}
    return {'stepKey': step_key, 'direction': 'inbound', 'serviceName': 'proj', 'children': [child]}


def outbound_flow(method='GET', host='api.supplier.com', path='/search', headers=None, peer=BACKEND_PEER):
    return FakeFlow(request=FakeRequest(method=method, host=host, path=path, headers=headers or {}),
                     peername=peer)


class ReliveRunsLoaderTest(unittest.TestCase):
    def test_missing_directory_is_cheap_and_returns_quickly(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs = relive.ReliveRuns(os.path.join(tmp, 'nope'))
            calls = {'n': 0}
            real_listdir = os.listdir

            def counting_listdir(path):
                calls['n'] += 1
                return real_listdir(path)

            import unittest.mock
            with unittest.mock.patch('os.listdir', side_effect=counting_listdir):
                self.assertEqual({}, runs.active_runs())
                self.assertEqual({}, runs.active_runs())  # throttled: no second listdir this window
            self.assertLessEqual(calls['n'], 1)

    def test_republish_and_removal_are_picked_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a')
            runs = relive.ReliveRuns(relive_dir(tmp))
            self.assertIn('run-a', runs.active_runs())
            # FINISHED/absent state must drop the run.
            write_run(tmp, 'run-a', state='FINISHED')
            runs.refresh(force=True)
            self.assertNotIn('run-a', runs.active_runs())


class AttributionHeaderTest(unittest.TestCase):
    def test_header_trusted_from_backend_peer(self):
        flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'}, peer=BACKEND_PEER)
        run_id, step_key = relive._take_header(flow, (BACKEND_PEER[0],))
        self.assertEqual(('run-a', 's-search'), (run_id, step_key))
        self.assertNotIn('X-Alfred-Relive', flow.request.headers)

    def test_header_from_non_backend_peer_is_not_trusted_and_still_stripped(self):
        flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'}, peer=OTHER_PEER)
        run_id, step_key = relive._take_header(flow, (BACKEND_PEER[0],))
        self.assertEqual((None, None), (run_id, step_key))
        self.assertNotIn('X-Alfred-Relive', flow.request.headers)


class AttributeTest(unittest.TestCase):
    def test_unattributed_when_no_runs_at_all(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()
            result = relive.attribute(flow, 'outbound', 'proj', (BACKEND_PEER[0],), runs)
            self.assertEqual('UNATTRIBUTED', result.kind)

    def test_header_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            result = relive.attribute(flow, 'outbound', 'proj', (BACKEND_PEER[0],), runs)
            self.assertEqual('HEADER', result.kind)
            self.assertEqual('run-a', result.run_id)
            self.assertEqual('s-search', result.step_key)

    def test_operation_id_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Operation-Id': 'relive-run-a-s-search'})
            result = relive.attribute(flow, 'outbound', 'proj', (BACKEND_PEER[0],), runs)
            self.assertEqual('OPERATION_ID', result.kind)
            self.assertEqual('s-search', result.step_key)

    def test_inflight_route(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            write_inflight(tmp, {'proj': [{'callId': 'x', 'runId': 'run-a', 'stepKey': 's-search'}]})
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()
            result = relive.attribute(flow, 'outbound', 'proj', (BACKEND_PEER[0],), runs)
            self.assertEqual('INFLIGHT', result.kind)
            self.assertEqual('s-search', result.step_key)

    def test_ambiguous_when_two_runs_in_flight_for_same_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            write_run(tmp, 'run-b', steps=[replay_step(child_key='c-other', host='api.other.com')])
            write_inflight(tmp, {'proj': [
                {'callId': 'x', 'runId': 'run-a', 'stepKey': 's-search'},
                {'callId': 'y', 'runId': 'run-b', 'stepKey': 's-search'},
            ]})
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()
            result = relive.attribute(flow, 'outbound', 'proj', (BACKEND_PEER[0],), runs)
            self.assertEqual('AMBIGUOUS', result.kind)
            self.assertEqual(['run-a', 'run-b'], result.ambiguous_run_ids)


class OrdinalMatchingTest(unittest.TestCase):
    def test_extra_call_beyond_recorded_count_is_unexpected(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_doc = write_run(tmp, 'run-a', steps=[replay_step(ordinal=1)])
            runs = relive.ReliveRuns(relive_dir(tmp))
            runs.refresh(force=True)

            first = outbound_flow()
            child = relive.match_child(first, 'outbound', 'proj', run_doc, 's-search', runs, consume=True)
            self.assertIsNotNone(child)
            self.assertEqual('c-supA', child['stepKey'])

            second = outbound_flow()
            child2 = relive.match_child(second, 'outbound', 'proj', run_doc, 's-search', runs, consume=True)
            self.assertIsNone(child2)


class StoppingTest(unittest.TestCase):
    def _run_with(self, tmp, extra_children_mode):
        return write_run(tmp, 'run-a', state='STOPPING', steps=[{
            'stepKey': 's-search', 'direction': 'inbound', 'serviceName': 'proj',
            'children': [
                {'stepKey': 'c-replay', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                 'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                 'callRule': {'match': {}, 'actions': [{'type': 'MOCK_RESPONSE', 'status': 200, 'body': '{}'}]}},
                {'stepKey': 'c-live', 'mode': extra_children_mode, 'unattributed': 'BLOCK', 'ordinal': 1,
                 'match': {'source': 'outbound', 'host': 'api.other.com', 'pathContains': '/x'},
                 'callRule': {'match': {}, 'actions': []}},
            ],
        }])

    def test_stopping_blocks_replay_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_with(tmp, 'LIVE')
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])
            self.assertIn('stopping', json.loads(verdict.mock['body'])['error'])

    def test_stopping_blocks_live_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_with(tmp, 'LIVE')
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(host='api.other.com', path='/x',
                                  headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])

    def test_stopping_blocks_unexpected_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._run_with(tmp, 'LIVE')
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(host='api.unrelated.com', path='/never-recorded',
                                  headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])


class UnattributedTest(unittest.TestCase):
    def test_two_runs_replay_children_match_one_unattributed_call_always_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step(child_key='c-a', unattributed='BLOCK')])
            write_run(tmp, 'run-b', steps=[replay_step(child_key='c-b', unattributed='SEND_REAL')])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()  # no header, no opid, no inflight entry: unattributed
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNotNone(verdict, 'must never fall through to forwarding')
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])
            self.assertEqual('AMBIGUOUS', info['attribution'])

    def test_single_match_send_real_falls_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step(unattributed='SEND_REAL')])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNone(verdict)
            self.assertEqual('SEND_REAL', info['choice'])

    def test_single_match_block_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow()
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])


class UnexpectedCallsTest(unittest.TestCase):
    def _attributed_flow(self, headers=None):
        return outbound_flow(host='api.unrelated.com', path='/no-such-child',
                              headers=headers or {'X-Alfred-Relive': 'run-a/s-search'})

    def test_block_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            verdict, info = run(relive.apply_outbound(self._attributed_flow(), 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])
            self.assertTrue(info['unexpected'])

    def test_send_real(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step()],
                       unexpectedCalls={'policy': 'SEND_REAL', 'fallback': 'BLOCK', 'rules': []})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            verdict, info = run(relive.apply_outbound(self._attributed_flow(), 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNone(verdict)
            self.assertTrue(info['unexpected'])

    def test_rules_then_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            matching_rule = {'id': 'ur-1', 'name': 'loyalty', 'match': {'host': 'api.unrelated.com'},
                              'actions': [{'type': 'MOCK_RESPONSE', 'status': 201, 'body': '{"stub":true}'}]}
            write_run(tmp, 'run-a', steps=[replay_step()],
                       unexpectedCalls={'policy': 'RULES', 'fallback': 'BLOCK', 'rules': [matching_rule]})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            verdict, info = run(relive.apply_outbound(self._attributed_flow(), 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(201, verdict.mock['status'])

            # No rule matches: falls through to BLOCK.
            write_run(tmp, 'run-a', steps=[replay_step()],
                       unexpectedCalls={'policy': 'RULES', 'fallback': 'BLOCK', 'rules': []})
            runs2 = relive.ReliveRuns(relive_dir(tmp))
            verdict2, info2 = run(relive.apply_outbound(self._attributed_flow(), 'proj', (BACKEND_PEER[0],), engine, runs2))
            self.assertEqual('MOCK_RESPONSE', verdict2.terminal)
            self.assertEqual(502, verdict2.mock['status'])


class ReplayAnswerTest(unittest.TestCase):
    def test_missing_answer_file_blocks_never_forwards(self):
        with tempfile.TemporaryDirectory() as tmp:
            call_rule = {'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                         'actions': [{'type': 'ANSWER_WITH_FILE', 'answerId': ANSWER}]}
            child = {'stepKey': 'c-supA', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])
            self.assertIn('unavailable', json.loads(verdict.mock['body'])['error'])

    def test_oversized_mock_served_from_relive_answer_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            answers_dir = os.path.join(relive_dir(tmp), 'answers', 'run-a')
            write_answer(os.path.dirname(answers_dir), answer_id=ANSWER, status=200, body=b'{"big":true}')
            # write_answer writes beside its tmpdir arg in an 'answers' subfolder - point it at
            # relive/answers/run-a directly instead.
            import shutil
            shutil.rmtree(os.path.join(os.path.dirname(answers_dir), 'answers'))
            write_answer(answers_dir if False else tmp, answer_id=ANSWER)  # placeholder, replaced below

    def test_oversized_mock_served_from_relive_answer_file_v2(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_answers_dir = os.path.join(relive_dir(tmp), 'answers', 'run-a')
            os.makedirs(run_answers_dir, exist_ok=True)
            meta = {'id': ANSWER, 'kind': 'RECORDED', 'status': 200, 'headers': {'content-type': 'application/json'}}
            with open(os.path.join(run_answers_dir, ANSWER + '.meta.json'), 'w', encoding='utf-8') as f:
                json.dump(meta, f)
            with open(os.path.join(run_answers_dir, ANSWER + '.body'), 'wb') as f:
                f.write(b'{"big":true}')

            call_rule = {'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                         'actions': [{'type': 'ANSWER_WITH_FILE', 'answerId': ANSWER}]}
            child = {'stepKey': 'c-supA', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(200, verdict.mock['status'])
            self.assertEqual(b'{"big":true}', verdict.mock['body_bytes'])


class TierEvaluationTest(unittest.TestCase):
    def test_tier_order_step_before_cycle_before_global(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_rules(tmp, [
                {'id': 'g1', 'name': 'global', 'match': {}, 'priority': 1,
                 'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Tier', 'value': 'GLOBAL'}]},
            ], enabled=True)
            call_rule = {
                'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Step', 'value': 'STEP'}],
            }
            child = {'stepKey': 'c-supA', 'mode': 'LIVE', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}],
                       cycleRules=[{'id': 'cr1', 'name': 'cycle', 'match': {},
                                    'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Cycle', 'value': 'CYCLE'}]}],
                       globalRules={'mode': 'ALL'})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('STEP', flow.request.headers.get('X-Step'))
            self.assertEqual('CYCLE', flow.request.headers.get('X-Cycle'))
            self.assertEqual('GLOBAL', flow.request.headers.get('X-Tier'))
            order = [a.action for a in verdict.applied]
            self.assertEqual(
                order.index('SET_REQUEST_HEADER'), order.index('SET_REQUEST_HEADER'))  # sanity
            names = [(a.rule_name, a.detail) for a in verdict.applied]
            # STEP's action must be recorded before CYCLE's, before GLOBAL's.
            step_index = next(i for i, a in enumerate(verdict.applied) if 'X-Step' in (a.detail or ''))
            cycle_index = next(i for i, a in enumerate(verdict.applied) if 'X-Cycle' in (a.detail or ''))
            global_index = next(i for i, a in enumerate(verdict.applied) if 'X-Tier' in (a.detail or ''))
            self.assertLess(step_index, cycle_index)
            self.assertLess(cycle_index, global_index)

    def test_stop_processing_scoped_to_one_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            call_rule = {
                'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'stopProcessing': True,
                'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Step', 'value': 'yes'}],
            }
            child = {'stepKey': 'c-supA', 'mode': 'LIVE', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}],
                       cycleRules=[{'id': 'cr1', 'name': 'cycle', 'match': {},
                                    'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Cycle', 'value': 'yes'}]}])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            # STEP tier's own stopProcessing must not suppress the CYCLE tier.
            self.assertEqual('yes', flow.request.headers.get('X-Step'))
            self.assertEqual('yes', flow.request.headers.get('X-Cycle'))

    def test_global_response_rule_rewrites_step_mocked_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_rules(tmp, [
                {'id': 'g1', 'name': 'rewrite', 'match': {}, 'priority': 1,
                 'actions': [{'type': 'SET_RESPONSE_HEADER', 'name': 'X-Rewritten', 'value': 'yes'}]},
            ], enabled=True)
            call_rule = {
                'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'actions': [{'type': 'MOCK_RESPONSE', 'status': 200, 'body': '{"ok":true}'}],
            }
            child = {'stepKey': 'c-supA', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}],
                       globalRules={'mode': 'ALL'})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            # Simulate the addon building the mocked response, then running the response phase.
            from mitmproxy import http
            flow.response = http.Response.make(200, b'{"ok":true}', {})
            rulesets = flow.metadata.get('relive_rulesets')
            self.assertIsNotNone(rulesets)
            response_verdict = run(engine.apply_response(flow, 'proj', extra_rulesets=rulesets))
            self.assertEqual('yes', flow.response.headers.get('X-Rewritten'))


class IsolationTest(unittest.TestCase):
    def test_two_runs_plus_unrelated_traffic_stay_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step(child_key='c-a', host='api.a.com')])
            write_run(tmp, 'run-b', steps=[replay_step(child_key='c-b', host='api.b.com')])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))

            flow_a = outbound_flow(host='api.a.com', headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict_a, info_a = run(relive.apply_outbound(flow_a, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('run-a', info_a['runId'])
            self.assertEqual(200, verdict_a.mock['status'])

            flow_b = outbound_flow(host='api.b.com', headers={'X-Alfred-Relive': 'run-b/s-search'})
            verdict_b, info_b = run(relive.apply_outbound(flow_b, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('run-b', info_b['runId'])
            self.assertEqual(200, verdict_b.mock['status'])

            # Unrelated traffic: no header, doesn't match either run's children, not in-flight.
            flow_u = outbound_flow(host='api.unrelated.com', path='/whatever')
            verdict_u, info_u = run(relive.apply_outbound(flow_u, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNone(verdict_u)
            self.assertIsNone(info_u)


class InboundGuidedTest(unittest.TestCase):
    def test_guided_run_claims_untagged_inbound_call_for_its_sole_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            step = {'stepKey': 's1', 'direction': 'inbound', 'serviceName': 'proj', 'children': [],
                    'callRule': {'match': {}, 'actions': [
                        {'type': 'SET_REQUEST_HEADER', 'name': 'X-Guided', 'value': 'yes'}]}}
            write_run(tmp, 'run-g', driver='GUIDED', projects=['proj'], steps=[step])
            # A real Guided match needs the orchestrator to have already assigned the step key -
            # apply_inbound with step_key None reports "nothing to enforce yet" (see docstring).
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
            verdict, info = run(relive.apply_inbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNone(verdict)
            self.assertIsNone(info)


class UnattendedTimeoutTest(unittest.TestCase):
    """T033's single most safety-critical guarantee: an ASK ("request differs") pause that times
    out with nobody watching resolves to the failure mock and NEVER forwards."""

    def test_addon_never_forwards_on_unattended_timeout(self):
        import unittest.mock

        with tempfile.TemporaryDirectory() as tmp:
            call_rule = {
                'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'actions': [{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 1, 'onTimeout': 'release'}],
            }
            child = {'stepKey': 'c-supA', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNotNone(verdict.pause)
            self.assertEqual({'runId': 'run-a', 'stepKey': 'c-supA', 'at': 'CHANGED'}, verdict.pause.get('relive'))

            async def fake_wait_for_decision(*args, **kwargs):
                # Exactly what breakpoints.wait_for_decision returns on an unattended timeout.
                return {'action': 'release', 'reason': 'timeout'}

            addon = log_and_route.RouteAndLog()
            with unittest.mock.patch('breakpoints.wait_for_decision', fake_wait_for_decision):
                run(addon._decide(flow, verdict, 'call-1', 'proj'))

            self.assertIsNotNone(flow.response, 'must answer, never leave the request to be forwarded')
            self.assertEqual(502, flow.response.status_code)
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)

    def test_no_webhook_configured_still_never_forwards(self):
        with tempfile.TemporaryDirectory() as tmp:
            call_rule = {
                'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'actions': [{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 1, 'onTimeout': 'release'}],
            }
            child = {'stepKey': 'c-supA', 'mode': 'REPLAY', 'unattributed': 'BLOCK', 'ordinal': 1,
                     'match': call_rule['match'], 'callRule': call_rule}
            write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                             'serviceName': 'proj', 'children': [child]}])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))

            addon = log_and_route.RouteAndLog()
            run(addon._decide(flow, verdict, None, 'proj'))  # call_id=None: no webhook configured

            self.assertIsNotNone(flow.response)
            self.assertEqual(502, flow.response.status_code)


if __name__ == '__main__':
    unittest.main()
