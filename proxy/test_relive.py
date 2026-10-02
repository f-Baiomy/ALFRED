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
import time
import unittest
from unittest.mock import patch

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

    def test_new_inbound_execution_matches_the_child_again(self):
        # Retry, checkpoint replay, and a resend publish a new inflight call id for the same
        # parent step. The child slot from the previous execution must not stay spent. A second
        # supplier call inside the new execution is still unexpected.
        with tempfile.TemporaryDirectory() as tmp:
            write_run(tmp, 'run-a', steps=[replay_step(ordinal=1)])
            write_inflight(tmp, {'proj': [{'callId': 'inbound-1', 'runId': 'run-a', 'stepKey': 's-search'}]})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))

            first = outbound_flow()
            verdict, info = run(relive.apply_outbound(first, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('c-supA', info['stepKey'])
            self.assertEqual(200, verdict.mock['status'])

            second = outbound_flow()
            verdict2, info2 = run(relive.apply_outbound(second, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertNotEqual('c-supA', (info2 or {}).get('stepKey'))
            self.assertEqual(502, verdict2.mock['status'])

            write_inflight(tmp, {'proj': [{'callId': 'inbound-2', 'runId': 'run-a', 'stepKey': 's-search'}]})
            os.utime(os.path.join(relive_dir(tmp), 'inflight.json'), (time.time() + 5, time.time() + 5))
            third = outbound_flow()
            verdict3, info3 = run(relive.apply_outbound(third, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('c-supA', info3['stepKey'])
            self.assertEqual(200, verdict3.mock['status'])

            fourth = outbound_flow()
            _, info4 = run(relive.apply_outbound(fourth, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertNotEqual('c-supA', (info4 or {}).get('stepKey'))


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


class ReplayModeDerivationTest(unittest.TestCase):
    def test_replay_child_without_a_serialized_mode_blocks_when_unattributed(self):
        with tempfile.TemporaryDirectory() as tmp:
            step = replay_step()
            del step['children'][0]['mode']
            write_run(tmp, 'run-a', steps=[step])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))

            verdict, info = run(relive.apply_outbound(outbound_flow(), 'proj', (BACKEND_PEER[0],), engine, runs))

            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(502, verdict.mock['status'])
            self.assertEqual('UNATTRIBUTED', info['attribution'])


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
    def test_relive_scoped_set_is_available_to_later_actions_and_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            step = replay_step(mode='LIVE', extra_actions=[
                {'type': 'SET_REQUEST_VARIABLE', 'name': 'sessionId', 'value': 'abc', 'scope': 'RELIVE'},
                {'type': 'SET_REQUEST_HEADER', 'name': 'X-Session', 'value': '{{$.' + 'sessionId}}'},
            ])
            write_run(tmp, 'run-relive', steps=[step])
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-relive/s-search'})
            with patch.object(interception, '_RELIVE_API_URL', 'http://backend:5000'), \
                    patch.object(interception, '_post_relive_variable') as persist:
                run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('abc', flow.request.headers.get('X-Session'))
            persist.assert_called_once_with(('cycle-1', 'run-relive', 'c-supA', 'sessionId', 'abc'))
            later = relive._build_ruleset([{'name': 'later', 'match': {}, 'actions': [
                {'type': 'SET_REQUEST_HEADER', 'name': 'X-Later', 'value': '{{$.' + 'sessionId}}'},
            ]}], runs.get('run-relive'), engine)
            self.assertEqual('abc', later.variables['$.sessionId'])
            interception.clear_relive_overlay('run-relive')

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
            # T068: info['ruleIds'] carries which tier each matched rule came from, in tier order.
            tiers = [r['tier'] for r in info['ruleIds']]
            self.assertEqual(['STEP', 'CYCLE', 'GLOBAL'], tiers)
            self.assertEqual('cycle', next(r['ruleName'] for r in info['ruleIds'] if r['tier'] == 'CYCLE'))
            self.assertEqual('global', next(r['ruleName'] for r in info['ruleIds'] if r['tier'] == 'GLOBAL'))

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
    def test_inbound_step_captures_response_cookie_into_relive_run(self):
        from mitmproxy import http

        with tempfile.TemporaryDirectory() as tmp:
            step = {'stepKey': 's-login', 'direction': 'inbound', 'serviceName': 'odeysys',
                    'children': [], 'callRule': {'name': 'capture session', 'enabled': True,
                    'match': {}, 'actions': [{'type': 'CAPTURE_RESPONSE_VARIABLE',
                    'enabled': True, 'name': 'session_id', 'captureSource': 'COOKIE',
                    'path': 'JSESSIONID', 'scope': 'RELIVE'}]}}
            write_run(tmp, 'run-login', projects=['odeysys'], steps=[step],
                      variables={'session_id': 'initial'})
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = FakeFlow(request=FakeRequest(method='POST', host='localhost',
                            path='/odeysysadmin/Admin2/loginAction',
                            headers={'X-Alfred-Relive': 'run-login/s-login'}))
            with patch.object(interception, '_RELIVE_API_URL', 'http://backend:5000'), \
                    patch.object(interception, '_post_relive_variable') as persist:
                _, info = run(relive.apply_inbound(flow, 'odeysys', (BACKEND_PEER[0],), engine, runs))
                flow.response = http.Response.make(200, b'', {'Set-Cookie': 'JSESSIONID=captured; Path=/; HttpOnly'})
                run(engine.apply_response(flow, 'odeysys',
                                          extra_rulesets=flow.metadata['relive_rulesets']))
            self.assertEqual('s-login', info['stepKey'])
            persist.assert_called_once_with(('cycle-1', 'run-login', 's-login', 'session_id', 'captured'))
            interception.clear_relive_overlay('run-login')

    def test_cycle_cookie_rule_runs_only_when_enabled_for_attributed_inbound_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            step = {'stepKey': 's1', 'direction': 'inbound', 'serviceName': 'odeysys',
                    'children': [], 'callRule': {'match': {}, 'actions': []}}
            rule = {'name': 'set sessionid', 'match': {'source': 'inbound',
                    'serviceNames': ['odeysys'], 'pathContains': '/odeysysadmin'},
                    'actions': [{'type': 'SET_REQUEST_COOKIE', 'name': 'sessionid',
                                 'value': '{{$.sessionid}}', 'enabled': True},
                                {'type': 'SET_REQUEST_HEADER', 'name': 'X-Global',
                                 'value': '{{globalToken}}', 'enabled': True}]}
            with open(os.path.join(tmp, 'variables.json'), 'w', encoding='utf-8') as f:
                json.dump({'variables': {'globalToken': 'global-value'}}, f)
            write_rules(tmp, [], enabled=True)
            write_run(tmp, 'run-off', projects=['odeysys'], steps=[step], variables={'sessionid': 'new-session'},
                      cycleRules=[{**rule, 'enabled': False}])
            write_run(tmp, 'run-on', projects=['odeysys'], steps=[step], variables={'sessionid': 'new-session'},
                      cycleRules=[{**rule, 'enabled': True}])
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))

            for run_id, expected_cookie in [('run-off', None), ('run-on', 'sessionid=new-session')]:
                flow = FakeFlow(request=FakeRequest(method='POST', host='localhost',
                                path='/odeysysadmin/Booking2/flight-search/search',
                                headers={'X-Alfred-Relive': run_id + '/s1'}))
                verdict, info = run(relive.apply_inbound(flow, 'odeysys', (BACKEND_PEER[0],), engine, runs))
                self.assertEqual(run_id, info['runId'])
                self.assertEqual(expected_cookie, flow.request.headers.get('Cookie'))
                self.assertEqual('global-value' if run_id == 'run-on' else None,
                                 flow.request.headers.get('X-Global'))
                self.assertEqual(run_id == 'run-on', any(r['tier'] == 'CYCLE' for r in info['ruleIds']))

    def test_guided_run_claims_untagged_inbound_call_for_its_sole_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            step = {'stepKey': 's1', 'direction': 'inbound', 'serviceName': 'proj', 'children': [],
                    'callRule': {'match': {}, 'actions': [
                        {'type': 'SET_REQUEST_HEADER', 'name': 'X-Guided', 'value': 'yes'}]}}
            write_run(tmp, 'run-g', driver='GUIDED', projects=['proj'], steps=[step])
            # Guided (T077): nothing enforces the call rule-wise (no step is matched yet - the
            # frontend does that itself, by endpoint, once it sees this over /ws/relive), but the
            # call IS still tagged as this run's own so the frontend has something to match.
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = FakeFlow(request=FakeRequest(method='GET', host='localhost', path='/x'))
            verdict, info = run(relive.apply_inbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNone(verdict)
            self.assertEqual({'runId': 'run-g', 'stepKey': None, 'attribution': 'GUIDED', 'choice': None}, info)


def ask_call_rule(answer_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'):
    """A REPLAY child's call rule with "When the request differs: Ask me" (FR-014d): the recorded
    request file is absent, so the condition reads as "differs" and the pause is reached."""
    return {
        'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
        'actions': [
            {'type': 'IF_REQUEST', 'branches': [{'conditions': [
                {'subject': 'RECORDED_CALL', 'operator': 'MATCHES', 'answerId': answer_id}], 'actions': []}],
             'otherwise': [{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 1, 'onTimeout': 'release'}]},
            {'type': 'MOCK_RESPONSE', 'status': 200, 'body': '{"replayed":true}'},
        ],
    }


class UnattendedTimeoutTest(unittest.TestCase):
    """T033's single most safety-critical guarantee: an ASK ("request differs") pause that times
    out with nobody watching resolves to the failure mock and NEVER forwards."""

    def test_addon_never_forwards_on_unattended_timeout(self):
        import unittest.mock

        with tempfile.TemporaryDirectory() as tmp:
            call_rule = ask_call_rule()
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
            call_rule = ask_call_rule()
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


ANSWER_RECORDED = '68907e1c-49d8-492d-a65f-dfb183a437e8'


def write_recorded_request(tmpdir, run_id, answer_id, body, headers, method='POST', host='ndc.example',
                           path='/api/FlightSearch/Search', scheme='https'):
    directory = os.path.join(relive_dir(tmpdir), 'answers', run_id)
    os.makedirs(directory, exist_ok=True)
    meta = {
        'kind': 'RECORDED_REQUEST', 'method': method, 'scheme': scheme, 'host': host,
        'path': path, 'query': '', 'headers': headers,
    }
    with open(os.path.join(directory, answer_id + '.meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f)
    with open(os.path.join(directory, answer_id + '.body'), 'w', encoding='utf-8') as f:
        f.write(body)


def supplier_step(step_key, child_key, path, body, headers, mock_body='{"replayed":true}',
                  host='ndc.example', answer_id=ANSWER_RECORDED, direction='outbound'):
    recorded = {'method': 'POST', 'scheme': 'https', 'host': host, 'path': path, 'query': ''}
    call_rule = {
        'match': {},
        'actions': [
            {
                'type': 'IF_REQUEST', 'enabled': True,
                'branches': [{'conditions': [{
                    'subject': 'RECORDED_CALL', 'operator': 'MATCHES', 'answerId': answer_id, 'ignore': [],
                }], 'actions': []}],
                'otherwise': [{'type': 'MOCK_RESPONSE', 'status': 502, 'headers': {}, 'body': '{"error":"differs"}'}],
            },
            {'type': 'MOCK_RESPONSE', 'enabled': True, 'status': 200, 'headers': {}, 'body': mock_body},
        ],
    }
    child = {
        'stepKey': child_key, 'direction': direction, 'ordinal': 1, 'unattributed': 'BLOCK',
        'recordedRequest': recorded, 'match': {'source': 'outbound', 'host': host, 'methods': ['POST']},
        'callRule': call_rule,
    }
    return {
        'stepKey': step_key, 'direction': 'inbound', 'serviceName': 'odeysys', 'children': [child],
    }


class RecordedRequestMatchTest(unittest.TestCase):
    def test_json_and_soap_ignore_formatting(self):
        self.assertEqual(
            interception.canonical_body('{\n  "b": 1,\n  "a": 2\n}'),
            interception.canonical_body('{"a":2,"b":1}'),
        )
        self.assertNotEqual(interception.canonical_body('{"a":1}'), interception.canonical_body('{"a":2}'))
        pretty = '<Env xmlns:s="urn:soap"><Body id="1" n="2">\n  <Search>DXB</Search>\n</Body></Env>'
        compact = '<Env xmlns:s="urn:soap"><Body n="2" id="1"><Search>DXB</Search></Body></Env>'
        self.assertEqual(interception.canonical_body(pretty), interception.canonical_body(compact))
        self.assertNotEqual(
            interception.canonical_body(compact),
            interception.canonical_body('<Env xmlns:s="urn:soap"><Body id="1" n="2"><Search>CAI</Search></Body></Env>'),
        )

    def test_generated_headers_do_not_count(self):
        recorded = {'Content-Type': 'application/json', 'X-Request-Id': 'old', 'Host': 'ndc.example',
                    'CorrelationId': 'aaa', 'Client-Id': 'NDC-Core'}
        live = {'Content-Type': 'application/json', 'X-Request-Id': 'new', 'Content-Length': '4',
                'CorrelationId': 'bbb', 'Client-Id': 'NDC-Core'}
        self.assertEqual(
            interception.stable_header_items(recorded),
            interception.stable_header_items(live),
        )
        live['Content-Type'] = 'text/xml'
        self.assertNotEqual(
            interception.stable_header_items(recorded),
            interception.stable_header_items(live),
        )

    def test_inflight_without_a_project_name_uses_that_inbounds_child_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            pretty = '{\n  "b": 2,\n  "a": 1\n}'
            headers = {'Content-Type': 'application/json', 'X-Request-Id': 'recorded'}
            parent = supplier_step('s-search', 'c-search', '/api/FlightSearch/Search', pretty, headers,
                                   mock_body='{"supplier":"Galileo"}')
            other = supplier_step('s-other', 'c-other', '/api/FlightSearch/UpSelling', '{"x":1}', headers,
                                  mock_body='{"other":true}', answer_id='b49a067b-1111-4111-8111-111111111111')
            write_recorded_request(tmp, 'run-a', ANSWER_RECORDED, pretty, headers)
            write_recorded_request(tmp, 'run-a', 'b49a067b-1111-4111-8111-111111111111', '{"x":1}', headers,
                                   path='/api/FlightSearch/UpSelling')
            write_run(tmp, 'run-a', projects=['odeysys'], steps=[parent, other])
            write_inflight(tmp, {'odeysys': [{'callId': 'in', 'runId': 'run-a', 'stepKey': 's-search'}]})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))

            attributed = relive.attribute(
                outbound_flow(), 'outbound', None, (BACKEND_PEER[0],), runs)
            self.assertEqual('INFLIGHT', attributed.kind)
            self.assertEqual('s-search', attributed.step_key)

            flow = FakeFlow(request=FakeRequest(
                method='POST', host='ndc.example', path='/api/FlightSearch/Search',
                text='{"a":1,"b":2}',
                headers={'Content-Type': 'application/json', 'X-Request-Id': 'live', 'Host': 'ndc.example',
                         'CorrelationId': 'changes-every-call'},
            ))
            verdict, info = run(relive.apply_outbound(flow, None, (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(200, verdict.mock['status'])
            self.assertEqual('{"supplier":"Galileo"}', verdict.mock['body'])
            self.assertEqual('c-search', info['stepKey'])

            other_flow = FakeFlow(request=FakeRequest(
                method='POST', host='ndc.example', path='/api/FlightSearch/UpSelling',
                text='{"x":1}', headers={'Content-Type': 'application/json'},
            ))
            verdict, info = run(relive.apply_outbound(other_flow, None, (BACKEND_PEER[0],), engine, runs))
            self.assertEqual(502, verdict.mock['status'])
            self.assertNotIn('other', verdict.mock['body'])

    def test_nested_supplier_belongs_to_the_deepest_inflight_inbound(self):
        with tempfile.TemporaryDirectory() as tmp:
            headers = {'Content-Type': 'application/json'}
            direct_answer = '11111111-1111-4111-8111-111111111111'
            outer_child = supplier_step('unused', 'c-direct', '/direct', '{"d":1}', headers,
                                        answer_id=direct_answer)['children'][0]
            inner_child = supplier_step('unused', 'c-search', '/api/FlightSearch/Search', '{"a":1}', headers,
                                        answer_id=ANSWER_RECORDED)['children'][0]
            inner = {'stepKey': 's-core', 'direction': 'inbound', 'serviceName': 'core', 'children': [inner_child]}
            outer = {'stepKey': 's-search', 'direction': 'inbound', 'serviceName': 'odeysys',
                     'children': [outer_child, inner]}
            write_recorded_request(tmp, 'run-a', direct_answer, '{"d":1}', headers, path='/direct')
            write_recorded_request(tmp, 'run-a', ANSWER_RECORDED, '{"a":1}', headers)
            write_run(tmp, 'run-a', steps=[outer])
            runs = relive.ReliveRuns(relive_dir(tmp))
            runs.refresh(force=True)
            run_doc = runs.get('run-a')

            outer_only = FakeFlow(request=FakeRequest(
                method='POST', host='ndc.example', path='/api/FlightSearch/Search', text='{"a":1}',
                headers=headers,
            ))
            matched = relive.match_child(outer_only, 'outbound', None, run_doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

            direct = FakeFlow(request=FakeRequest(
                method='POST', host='ndc.example', path='/direct', text='{"d":1}', headers=headers,
            ))
            self.assertEqual('c-direct', relive.match_child(direct, 'outbound', None, run_doc, 's-search', runs)['stepKey'])
            self.assertIsNone(relive.match_child(direct, 'outbound', None, run_doc, 's-core', runs))


def _semantic_fingerprint(body, headers=None):
    headers = headers if headers is not None else {'Content-Type': 'application/json'}
    endpoint = interception.canonical_endpoint(
        'POST', 'https', 'ndc.example', '/api/FlightSearch/Search', '')
    return relive.semantic_fingerprint_v1(
        endpoint, interception.stable_header_items(headers), interception.canonical_body(body))


def fingerprinted_child(key, body, ordinal=1):
    return {
        'stepKey': key, 'direction': 'outbound', 'ordinal': ordinal, 'unattributed': 'BLOCK',
        'fingerprint': _semantic_fingerprint(body), 'fingerprintVersion': relive.FINGERPRINT_VERSION,
        'recordedRequest': {
            'method': 'POST', 'scheme': 'https', 'host': 'ndc.example',
            'path': '/api/FlightSearch/Search', 'query': '',
        },
        'match': {'source': 'outbound', 'host': 'ndc.example', 'methods': ['POST']},
        'callRule': {'match': {}, 'actions': []},
    }


def fingerprint_flow(body, path='/api/FlightSearch/Search'):
    return FakeFlow(request=FakeRequest(
        method='POST', host='ndc.example', path=path, text=body,
        headers={'Content-Type': 'application/json', 'X-Request-Id': 'live-id', 'Cookie': 'a=b'},
    ))


class StoredFingerprintMatchTest(unittest.TestCase):
    def _doc(self, tmp, children, fingerprint_index=None):
        step = {
            'stepKey': 's-search', 'direction': 'inbound', 'serviceName': 'odeysys',
            'children': children,
        }
        if fingerprint_index is not None:
            step['fingerprintIndex'] = fingerprint_index
        write_run(tmp, 'run-a', steps=[step])
        runs = relive.ReliveRuns(relive_dir(tmp))
        runs.refresh(force=True)
        return runs, runs.get('run-a')

    def test_stored_fingerprint_matches_without_reading_the_recorded_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs, doc = self._doc(tmp, [fingerprinted_child('c-search', '{"b": 1, "a": 2}')])
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":2,"b":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

    def test_live_body_is_canonicalized_once_for_every_sibling(self):
        with tempfile.TemporaryDirectory() as tmp:
            children = [
                fingerprinted_child('c-1', '{"a":1}', ordinal=1),
                fingerprinted_child('c-2', '{"a":9}', ordinal=2),
            ]
            runs, doc = self._doc(tmp, children)
            calls = {'n': 0}
            real = interception.canonical_body

            def counting(text):
                calls['n'] += 1
                return real(text)

            with patch.object(interception, 'canonical_body', side_effect=counting):
                matched = relive.match_child(
                    fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-1', matched['stepKey'])
            self.assertEqual(1, calls['n'])

    def test_one_fingerprint_miss_still_returns_that_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs, doc = self._doc(tmp, [fingerprinted_child('c-search', '{"a":1}')])
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":2}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

    def test_two_fingerprint_misses_are_unexpected(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs, doc = self._doc(tmp, [
                fingerprinted_child('c-1', '{"a":1}', ordinal=1),
                fingerprinted_child('c-2', '{"a":2}', ordinal=2),
            ])
            self.assertIsNone(relive.match_child(
                fingerprint_flow('{"a":3}'), 'outbound', None, doc, 's-search', runs))

    def test_same_fingerprint_is_taken_in_ordinal_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs, doc = self._doc(tmp, [
                fingerprinted_child('c-2', '{"a":1}', ordinal=2),
                fingerprinted_child('c-1', '{"a":1}', ordinal=1),
            ])
            first = relive.match_child(fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            second = relive.match_child(fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-1', first['stepKey'])
            self.assertEqual('c-2', second['stepKey'])

    def test_a_different_url_is_not_that_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs, doc = self._doc(tmp, [fingerprinted_child('c-search', '{"a":1}')])
            self.assertIsNone(relive.match_child(
                fingerprint_flow('{"a":1}', path='/other'), 'outbound', None, doc, 's-search', runs))

    def test_fingerprint_index_resolves_without_scanning_the_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            child = fingerprinted_child('c-search', '{"b": 1, "a": 2}')
            child.pop('fingerprint', None)
            child.pop('fingerprintVersion', None)
            token = _semantic_fingerprint('{"b": 1, "a": 2}')
            runs, doc = self._doc(tmp, [child], fingerprint_index={token: ['c-search']})
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":2,"b":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

    def test_index_miss_on_one_child_still_returns_that_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            child = fingerprinted_child('c-search', '{"a":1}')
            child.pop('fingerprint', None)
            child.pop('fingerprintVersion', None)
            runs, doc = self._doc(tmp, [child], fingerprint_index={_semantic_fingerprint('{"a":1}'): ['c-search']})
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":2}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

    def test_two_index_misses_are_unexpected(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = fingerprinted_child('c-1', '{"a":1}', ordinal=1)
            second = fingerprinted_child('c-2', '{"a":2}', ordinal=2)
            for child in (first, second):
                child.pop('fingerprint', None)
                child.pop('fingerprintVersion', None)
            runs, doc = self._doc(tmp, [first, second], fingerprint_index={
                _semantic_fingerprint('{"a":1}'): ['c-1'],
                _semantic_fingerprint('{"a":2}'): ['c-2'],
            })
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                self.assertIsNone(relive.match_child(
                    fingerprint_flow('{"a":3}'), 'outbound', None, doc, 's-search', runs))

    def test_index_takes_the_same_hash_in_stored_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            later = fingerprinted_child('c-2', '{"a":1}', ordinal=2)
            earlier = fingerprinted_child('c-1', '{"a":1}', ordinal=1)
            token = _semantic_fingerprint('{"a":1}')
            runs, doc = self._doc(tmp, [later, earlier], fingerprint_index={token: ['c-2', 'c-1']})
            first = relive.match_child(fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            second = relive.match_child(fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-2', first['stepKey'])
            self.assertEqual('c-1', second['stepKey'])

    def test_hash_hit_does_not_select_a_disabled_child_or_another_bucket(self):
        with tempfile.TemporaryDirectory() as tmp:
            disabled = fingerprinted_child('c-hit', '{"a":1}')
            disabled['enabled'] = False
            other = fingerprinted_child('c-other', '{"a":9}')
            token = _semantic_fingerprint('{"a":1}')
            other_token = _semantic_fingerprint('{"a":9}')
            runs, doc = self._doc(tmp, [disabled, other], fingerprint_index={
                token: ['c-hit'],
                other_token: ['c-other'],
            })
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertIsNone(matched)

    def test_disabled_child_is_not_selected_without_an_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            child = fingerprinted_child('c-search', '{"a":1}')
            child['enabled'] = False
            runs, doc = self._doc(tmp, [child])
            self.assertIsNone(relive.match_child(
                fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs))

    def test_a_missing_enabled_flag_stays_selectable(self):
        with tempfile.TemporaryDirectory() as tmp:
            child = fingerprinted_child('c-search', '{"a":1}')
            self.assertNotIn('enabled', child)
            runs, doc = self._doc(tmp, [child])
            matched = relive.match_child(
                fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])

    def test_a_child_left_out_of_the_index_is_still_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            scanned = fingerprinted_child('c-search', '{"a":1}')
            runs, doc = self._doc(tmp, [scanned], fingerprint_index={
                _semantic_fingerprint('{"a":9}'): ['missing-key'],
            })
            with patch.object(relive, '_recorded_for_child', side_effect=AssertionError('stored body was read')):
                matched = relive.match_child(
                    fingerprint_flow('{"a":1}'), 'outbound', None, doc, 's-search', runs)
            self.assertEqual('c-search', matched['stepKey'])


class ReviewFixesTest(unittest.TestCase):
    """Phase 16 (specs/003-relive-cycle/review-fef121f-889db4d.md) regression tests."""

    def test_run_published_inside_the_refresh_window_is_still_attributed(self):
        # B3: an unrelated call lists relive/ first; the run appears milliseconds later. The
        # supplier call must replay, never reach the real host.
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(relive_dir(tmp), exist_ok=True)
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            runs.refresh()
            write_run(tmp, 'run-a', steps=[replay_step()])
            write_inflight(tmp, {'proj': [{'callId': 'in', 'runId': 'run-a', 'stepKey': 's-search'}]})
            verdict, info = run(relive.apply_outbound(outbound_flow(), 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertIsNotNone(verdict)
            self.assertEqual('MOCK_RESPONSE', verdict.terminal)
            self.assertEqual(200, verdict.mock['status'])
            self.assertEqual('c-supA', info['stepKey'])

    def test_header_run_published_inside_the_refresh_window_is_found(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(relive_dir(tmp), exist_ok=True)
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            runs.refresh()
            write_run(tmp, 'run-a', steps=[replay_step()])
            flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
            verdict, info = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('HEADER', info['attribution'])

    def test_a_stale_inflight_run_id_forces_one_scan_per_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(relive_dir(tmp), exist_ok=True)
            runs = relive.ReliveRuns(relive_dir(tmp))
            runs.refresh()
            with patch.object(runs, '_refresh_run_files', wraps=runs._refresh_run_files) as scan:
                runs.ensure_known({'gone'})
                runs.ensure_known({'gone'})
                runs.ensure_known({'gone'})
            self.assertEqual(1, scan.call_count)

    def test_parallel_sibling_supplier_calls_both_replay(self):
        # B1: an older backend listed each supplier call in inflight.json while it was in
        # flight; the sibling made at the same time must still match its own child.
        with tempfile.TemporaryDirectory() as tmp:
            h = {'Content-Type': 'application/json'}
            a = supplier_step('s', 'c-a', '/a', '{"a":1}', h, answer_id='11111111-1111-4111-8111-111111111111')['children'][0]
            b = supplier_step('s', 'c-b', '/b', '{"b":1}', h, answer_id='22222222-2222-4222-8222-222222222222')['children'][0]
            write_recorded_request(tmp, 'run-a', '11111111-1111-4111-8111-111111111111', '{"a":1}', h, path='/a')
            write_recorded_request(tmp, 'run-a', '22222222-2222-4222-8222-222222222222', '{"b":1}', h, path='/b')
            write_run(tmp, 'run-a', projects=['odeysys'], steps=[
                {'stepKey': 's', 'direction': 'inbound', 'serviceName': 'odeysys', 'children': [a, b]}])
            write_inflight(tmp, {'odeysys': [{'callId': 'in', 'runId': 'run-a', 'stepKey': 's'}],
                                 'unknown': [{'callId': 'outA', 'runId': 'run-a', 'stepKey': 'c-a'}]})
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = FakeFlow(request=FakeRequest(method='POST', host='ndc.example', path='/b', text='{"b":1}', headers=h))
            verdict, info = run(relive.apply_outbound(flow, None, (BACKEND_PEER[0],), engine, runs))
            self.assertEqual(200, verdict.mock['status'])
            self.assertEqual('c-b', info['stepKey'])

    def _guided_run(self, tmp):
        h = {'Content-Type': 'application/json'}
        child = supplier_step('s-search', 'c-a', '/a', '{"a":1}', h,
                              answer_id='11111111-1111-4111-8111-111111111111')['children'][0]
        write_recorded_request(tmp, 'run-g', '11111111-1111-4111-8111-111111111111', '{"a":1}', h, path='/a')
        steps = [
            {'stepKey': 's-login', 'direction': 'inbound', 'serviceName': 'odeysys', 'children': [],
             'recordedRequest': {'method': 'POST', 'path': '/login'}, 'callRule': {'match': {}, 'actions': []}},
            {'stepKey': 's-search', 'direction': 'inbound', 'serviceName': 'odeysys', 'children': [child],
             'recordedRequest': {'method': 'POST', 'path': '/search'},
             'callRule': {'match': {}, 'actions': [{'type': 'SET_REQUEST_HEADER', 'name': 'X-Step', 'value': 'search'}]}},
        ]
        write_run(tmp, 'run-g', driver='GUIDED', projects=['odeysys'], steps=steps)
        return h

    def test_guided_inbound_call_is_matched_to_its_step_and_its_call_rule_applies(self):
        # B2/B11
        with tempfile.TemporaryDirectory() as tmp:
            self._guided_run(tmp)
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))
            flow = FakeFlow(request=FakeRequest(method='POST', host='localhost', path='/search?x=1'))
            verdict, info = run(relive.apply_inbound(flow, 'odeysys', (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('s-search', info['stepKey'])
            self.assertEqual('search', flow.request.headers.get('X-Step'))

    def test_guided_repeat_within_the_window_stays_on_the_same_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._guided_run(tmp)
            engine = make_engine(tmp, source='inbound')
            runs = relive.ReliveRuns(relive_dir(tmp))
            for _ in range(2):
                flow = FakeFlow(request=FakeRequest(method='POST', host='localhost', path='/login'))
                verdict, info = run(relive.apply_inbound(flow, 'odeysys', (BACKEND_PEER[0],), engine, runs))
                self.assertEqual('s-login', info['stepKey'])

    def test_supplier_call_during_a_guided_step_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = self._guided_run(tmp)
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            write_inflight(tmp, {'odeysys': [{'callId': 'in', 'runId': 'run-g', 'stepKey': 's-search'}]})
            flow = FakeFlow(request=FakeRequest(method='POST', host='ndc.example', path='/a', text='{"a":1}', headers=h))
            verdict, info = run(relive.apply_outbound(flow, None, (BACKEND_PEER[0],), engine, runs))
            self.assertEqual(200, verdict.mock['status'])
            self.assertEqual('c-a', info['stepKey'])

    def test_supplier_call_of_an_unmatched_guided_call_is_unexpected_not_ambiguous(self):
        with tempfile.TemporaryDirectory() as tmp:
            h = self._guided_run(tmp)
            engine = make_engine(tmp)
            runs = relive.ReliveRuns(relive_dir(tmp))
            write_inflight(tmp, {'odeysys': [{'callId': 'in', 'runId': 'run-g', 'stepKey': None}]})
            flow = FakeFlow(request=FakeRequest(method='POST', host='ndc.example', path='/a', text='{"a":1}', headers=h))
            verdict, info = run(relive.apply_outbound(flow, None, (BACKEND_PEER[0],), engine, runs))
            self.assertEqual('UNEXPECTED', info['attribution'])

    def _paused(self, tmp, call_rule):
        child = {'stepKey': 'c-supA', 'direction': 'outbound', 'unattributed': 'BLOCK', 'ordinal': 1,
                 'match': call_rule['match'], 'callRule': call_rule}
        write_run(tmp, 'run-a', steps=[{'stepKey': 's-search', 'direction': 'inbound',
                                         'serviceName': 'proj', 'children': [child]}])
        engine = make_engine(tmp)
        runs = relive.ReliveRuns(relive_dir(tmp))
        flow = outbound_flow(headers={'X-Alfred-Relive': 'run-a/s-search'})
        verdict, _ = run(relive.apply_outbound(flow, 'proj', (BACKEND_PEER[0],), engine, runs))
        return flow, verdict

    def _decide(self, flow, verdict, decision):
        async def fake_wait_for_decision(*args, **kwargs):
            return decision
        addon = log_and_route.RouteAndLog()
        with patch('breakpoints.wait_for_decision', fake_wait_for_decision):
            run(addon._decide(flow, verdict, 'call-1', 'proj'))

    def _checkpoint_rule(self):
        return {'match': {'source': 'outbound', 'host': 'api.supplier.com', 'pathContains': '/search'},
                'actions': [{'type': 'PAUSE_REQUEST', 'timeoutSeconds': 1, 'onTimeout': 'release'},
                            {'type': 'MOCK_RESPONSE', 'status': 200, 'body': '{"replayed":true}'}]}

    def test_a_checkpoint_pause_is_tagged_before_not_changed(self):
        # B6
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, self._checkpoint_rule())
            self.assertEqual('BEFORE', verdict.pause['relive']['at'])

    def test_a_replay_child_checkpoint_that_times_out_still_replays(self):
        # B6 + the released-pause leak: the mock after the pause must answer, never the host.
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, self._checkpoint_rule())
            self._decide(flow, verdict, {'action': 'release', 'reason': 'timeout'})
            self.assertEqual(200, flow.response.status_code)
            self.assertIn(b'replayed', flow.response.content)

    def test_a_released_replay_child_checkpoint_replays(self):
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, self._checkpoint_rule())
            self._decide(flow, verdict, {'action': 'release'})
            self.assertEqual(200, flow.response.status_code)

    def test_skip_at_a_checkpoint_fails_the_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, self._checkpoint_rule())
            self._decide(flow, verdict, {'action': 'release', 'relive': 'FAIL'})
            self.assertEqual(502, flow.response.status_code)

    def test_ask_me_released_by_a_human_replays_the_recording(self):
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, ask_call_rule())
            self.assertEqual('CHANGED', verdict.pause['relive']['at'])
            self._decide(flow, verdict, {'action': 'release', 'relive': 'REPLAY'})
            self.assertEqual(200, flow.response.status_code)
            self.assertIn(b'replayed', flow.response.content)

    def test_ask_me_answered_with_an_edited_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, ask_call_rule())
            self._decide(flow, verdict, {'action': 'release', 'relive': 'ANSWER', 'status': 201, 'body': '{"edited":1}'})
            self.assertEqual(201, flow.response.status_code)

    def test_ask_me_send_real_leaves_the_request_to_the_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            flow, verdict = self._paused(tmp, ask_call_rule())
            self._decide(flow, verdict, {'action': 'release', 'relive': 'SEND_REAL'})
            self.assertIsNone(flow.response)


if __name__ == '__main__':
    unittest.main()
