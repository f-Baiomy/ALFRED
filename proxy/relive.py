"""
Relive Cycle (specs/003-relive-cycle): the proxy-side half of "replay a recorded call tree
against the real app". This is a NEW module - interception.py is not grown - because everything
here is either attribution (deciding which run, if any, a live call belongs to) or plumbing
(building the RuleSets a run's snapshot describes) on top of the ordinary interception engine,
never a new kind of action. See contracts/proxy-snapshot.md for the file shapes and
specs/003-relive-cycle/research.md (D1-D4, D13-D18) for the "why".

Safety invariant that governs every function below: a REPLAY child, an unattributed call that
would otherwise reach a live host, and a call this module cannot cleanly account for must never
reach the real supplier without an explicit human "yes". When in doubt, this module blocks - see
_guard_replay, _match_unattributed_all's STOPPING branch, and force_failure_mock.
"""

import json
import os
import re
import time

import interception

# How often the relive/ directory is re-listed - "at most once a second" per
# contracts/proxy-snapshot.md. A wall-clock budget, not a directory mtime check: unlike
# interception._RulesCache's single file, a run's file can appear or disappear entirely (start/
# stop), and container filesystems don't reliably bump a directory's own mtime the same way on
# every platform this proxy runs on.
REFRESH_INTERVAL_SECONDS = 1.0

ACTIVE_STATES = ('RUNNING', 'STOPPING')

RELIVE_HEADER = 'X-Alfred-Relive'
OPERATION_ID_HEADER = 'X-Operation-Id'


def _default_dir():
    rules_file = interception.RULES_FILE
    return os.path.join(os.path.dirname(os.path.abspath(rules_file)), 'relive')


class AttributionResult:
    """One outcome of `attribute()`. `run` is the run's raw snapshot dict; `step_key` is the
    INBOUND (parent) step the call was tied to by HEADER/OPERATION_ID/INFLIGHT - never a child's
    key, since which child matches is a separate decision (see match_child)."""

    __slots__ = ('kind', 'run', 'step_key', 'ambiguous_run_ids')

    def __init__(self, kind, run=None, step_key=None, ambiguous_run_ids=None):
        self.kind = kind
        self.run = run
        self.step_key = step_key
        self.ambiguous_run_ids = ambiguous_run_ids

    @property
    def run_id(self):
        return self.run.get('runId') if self.run else None


class ReliveRuns:
    """Every published Relive run snapshot (relive/<runId>.json) plus relive/inflight.json,
    reloaded at most once a second - the loader pattern of interception._RulesCache, applied to a
    whole directory (a run's file appears and disappears, unlike rules.json's fixed path) instead
    of one file. Costs one failed `os.listdir` per refresh window when the directory does not
    exist, and nothing between windows.

    One instance is shared by both addon processes' whole lifetime (module-level in each addon),
    the same way InterceptionEngine's own _RulesCache is - a fresh one is only for tests that want
    an isolated directory.
    """

    def __init__(self, directory=None):
        self._dir = directory or _default_dir()
        self._last_check = None
        self._file_mtimes = {}   # filename -> mtime, for every relive/*.json currently loaded
        self._runs = {}          # runId -> snapshot dict, RUNNING/STOPPING only
        self._inflight = {}      # project -> [{'callId','runId','stepKey'}, ...]
        # Per-run, per-parent-step, per-endpoint-signature ordinal counters (research D3). Reset
        # implicitly whenever a run's file is reloaded or removed - see refresh().
        self._ordinals = {}

    def _stale(self):
        now = time.monotonic()
        if self._last_check is None or now - self._last_check >= REFRESH_INTERVAL_SECONDS:
            self._last_check = now
            return True
        return False

    def refresh(self, force=False):
        if not force and not self._stale():
            return
        try:
            names = os.listdir(self._dir)
        except OSError:
            # No directory: Relive has never run here, or has just been cleaned up. Reset so a
            # directory that reappears later (a new run starting) is read fresh, not left showing
            # whatever the last successful listing saw.
            if self._runs or self._inflight or self._file_mtimes:
                self._runs = {}
                self._inflight = {}
                self._file_mtimes = {}
                self._ordinals = {}
            return

        seen = set()
        for name in names:
            if not name.endswith('.json') or name == 'inflight.json':
                continue
            path = os.path.join(self._dir, name)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            seen.add(name)
            if self._file_mtimes.get(name) == mtime:
                continue
            self._file_mtimes[name] = mtime
            run_id = name[:-len('.json')]
            snapshot = self._load_json(path)
            if not isinstance(snapshot, dict) or snapshot.get('state') not in ACTIVE_STATES:
                self._runs.pop(run_id, None)
                self._forget_ordinals(run_id)
                continue
            snapshot.setdefault('runId', run_id)
            snapshot['_mtime'] = mtime
            self._runs[run_id] = snapshot

        for stale_name in [n for n in self._file_mtimes if n != 'inflight.json' and n not in seen]:
            del self._file_mtimes[stale_name]
            run_id = stale_name[:-len('.json')]
            self._runs.pop(run_id, None)
            self._forget_ordinals(run_id)

        inflight_path = os.path.join(self._dir, 'inflight.json')
        try:
            mtime = os.path.getmtime(inflight_path)
        except OSError:
            self._inflight = {}
            self._file_mtimes.pop('inflight.json', None)
        else:
            if self._file_mtimes.get('inflight.json') != mtime:
                self._file_mtimes['inflight.json'] = mtime
                loaded = self._load_json(inflight_path) or {}
                projects = loaded.get('projects') if isinstance(loaded, dict) else None
                self._inflight = projects if isinstance(projects, dict) else {}

    def _forget_ordinals(self, run_id):
        interception.clear_relive_overlay(run_id)
        for key in [k for k in self._ordinals if k[0] == run_id]:
            del self._ordinals[key]

    def _load_json(self, path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def active_runs(self):
        self.refresh()
        return self._runs

    def get(self, run_id):
        self.refresh()
        return self._runs.get(run_id)

    def inflight_for(self, project):
        self.refresh()
        entries = self._inflight.get(project) or []
        return [e for e in entries if isinstance(e, dict)]


def _default_runs():
    """One shared instance per addon process - see ReliveRuns' docstring."""
    global _SHARED_RUNS
    if _SHARED_RUNS is None:
        _SHARED_RUNS = ReliveRuns()
    return _SHARED_RUNS


_SHARED_RUNS = None


def _is_stopping(run):
    return (run.get('state') or '').upper() == 'STOPPING'


def _find_step(run, step_key):
    if not step_key:
        return None
    for step in run.get('steps') or []:
        if step.get('stepKey') == step_key:
            return step
    return None


def _child_match_raw(child):
    call_rule = child.get('callRule')
    if isinstance(call_rule, dict) and call_rule.get('match'):
        return call_rule.get('match')
    return child.get('match')


def _match_signature(child):
    return json.dumps(_child_match_raw(child) or {}, sort_keys=True)


def _request_host_path(flow):
    request = flow.request
    host = (getattr(request, 'pretty_host', None) or getattr(request, 'host', '') or '')
    return request, host, (request.path or '')


# ---------------------------------------------------------------------------------------------
# Attribution (research D2)
# ---------------------------------------------------------------------------------------------

def _take_header(flow, backend_addresses):
    """Pops X-Alfred-Relive off the request - ALWAYS, so it never reaches a rule, the call log or
    the upstream host - and returns (runId, stepKey) only when the peer really is Alfred's own
    backend. Exactly interception.take_resend_headers' rule, applied to this header instead: a
    client could otherwise forge it to claim an arbitrary run/step."""
    headers = flow.request.headers
    raw = headers.get(RELIVE_HEADER)
    if RELIVE_HEADER in headers:
        del headers[RELIVE_HEADER]
    if not raw:
        return None, None
    peer = getattr(flow.client_conn, 'peername', None)
    if not peer or peer[0] not in (backend_addresses or ()):
        return None, None
    run_id, _, step_key = raw.partition('/')
    if not run_id or not step_key:
        return None, None
    return run_id, step_key


def _take_operation_id(flow, active_run_ids):
    """X-Operation-Id: relive-<runId>-<stepKey> (never stripped - see
    interception.take_resend_headers' note: it's the application's header to propagate, not
    Alfred's to hide). Matched against the runIds this proxy actually has a snapshot for, rather
    than split on '-', because a run id is itself a UUID full of dashes and a naive last-'-' split
    would misparse it."""
    raw = (flow.request.headers.get(OPERATION_ID_HEADER) or '').strip()
    if not raw.startswith('relive-'):
        return None, None
    rest = raw[len('relive-'):]
    for run_id in active_run_ids:
        prefix = run_id + '-'
        if rest.startswith(prefix):
            step_key = rest[len(prefix):]
            if step_key:
                return run_id, step_key
    return None, None


def _runs_with_matching_outbound_child(flow, source, service_name, active_runs):
    """Every active run whose snapshot has AT LEAST ONE outbound child matching this request -
    used only to decide ambiguity (FR-050a), never to pick a specific child."""
    request, host, path = _request_host_path(flow)
    ids = set()
    for run_id, run in active_runs.items():
        for step in run.get('steps') or []:
            for child in step.get('children') or []:
                match_raw = _child_match_raw(child)
                if not match_raw:
                    continue
                try:
                    if interception.Match(match_raw).matches(
                            source, service_name, request.method, host, path, request, None):
                        ids.add(run_id)
                        break
                except Exception:
                    continue
            else:
                continue
            break
    return ids


def attribute(flow, source, service_name, backend_addresses, runs=None):
    """Which Relive run (if any) an OUTBOUND call belongs to - research D2, in order:
    HEADER -> OPERATION_ID -> INFLIGHT -> AMBIGUOUS -> UNATTRIBUTED. Returns an AttributionResult.

    `runs` lets the addon (and tests) share one ReliveRuns instance; a fresh one is created, and
    so costs one failed directory listing, when the caller has none to share."""
    runs = runs or _default_runs()
    active = runs.active_runs()

    header_run_id, header_step_key = _take_header(flow, backend_addresses)
    if header_run_id and header_run_id in active:
        return AttributionResult('HEADER', active[header_run_id], header_step_key)

    op_run_id, op_step_key = _take_operation_id(flow, active)
    if op_run_id:
        return AttributionResult('OPERATION_ID', active[op_run_id], op_step_key)

    if not active:
        # No run at all: nothing left to check, and nothing more to read from disk this call -
        # see ReliveRuns.refresh, which already made that cheap.
        return AttributionResult('UNATTRIBUTED')

    entries = runs.inflight_for(service_name) if service_name else []
    with_run = [e for e in entries if e.get('runId') in active]
    in_flight_run_ids = {e['runId'] for e in with_run}

    matching_run_ids = _runs_with_matching_outbound_child(flow, source, service_name, active)

    if len(in_flight_run_ids) > 1 or len(matching_run_ids) > 1:
        ambiguous = sorted(in_flight_run_ids | matching_run_ids)
        return AttributionResult('AMBIGUOUS', ambiguous_run_ids=ambiguous)

    if len(with_run) == 1:
        entry = with_run[0]
        return AttributionResult('INFLIGHT', active[entry['runId']], entry.get('stepKey'))

    return AttributionResult('UNATTRIBUTED')


def _match_unattributed_all(flow, source, service_name, runs):
    """Every (run, child) pair whose REPLAY child matches an UNATTRIBUTED call - used for the
    unattributed choice (FR-049a) and for detecting the "claimed by more than one run" case even
    when in-flight uniqueness didn't (a request can match a child of a run with no in-flight
    inbound call at all, e.g. a stale or misconfigured match)."""
    request, host, path = _request_host_path(flow)
    found = []
    for run in runs.active_runs().values():
        for step in run.get('steps') or []:
            for child in step.get('children') or []:
                if (child.get('mode') or '').upper() != 'REPLAY':
                    continue
                match_raw = _child_match_raw(child)
                if not match_raw:
                    continue
                try:
                    if interception.Match(match_raw).matches(
                            source, service_name, request.method, host, path, request, None):
                        found.append((run, child))
                except Exception:
                    continue
    return found


def match_child(flow, source, service_name, run, parent_step_key, runs, consume=True):
    """The run's child (of the step in flight) this outbound call matches, by endpoint + order
    (research D3): among the children whose match tests hold, the one whose recorded `ordinal`
    equals the Nth time (within this run, this parent step, this endpoint) a matching call has
    arrived. None when no child matches at all, or every matching child's ordinal has already
    been used up (an unexpected extra call - FR-014f).

    `consume=False` peeks (used while a run is STOPPING, so the ordinal counters used by later,
    still-RUNNING calls aren't disturbed by a call that is about to be blocked outright).
    """
    step = _find_step(run, parent_step_key)
    if step is None:
        return None
    request, host, path = _request_host_path(flow)
    run_id = run.get('runId')

    by_signature = {}
    for child in step.get('children') or []:
        match_raw = _child_match_raw(child)
        if not match_raw:
            continue
        try:
            if not interception.Match(match_raw).matches(
                    source, service_name, request.method, host, path, request, None):
                continue
        except Exception:
            continue
        by_signature.setdefault(_match_signature(child), []).append(child)

    for signature, children in by_signature.items():
        key = (run_id, parent_step_key, signature)
        count = runs._ordinals.get(key, 0) + 1
        for child in children:
            if (child.get('ordinal') or 1) == count:
                if consume:
                    runs._ordinals[key] = count
                return child

    if by_signature and consume:
        # At least one endpoint group matched, but its ordinals are all spoken for - one call
        # more than the recording had. Recorded against the first group so a LATER extra call
        # doesn't reuse the same slot - see the module docstring's unexpected-call test.
        first_key = (run_id, parent_step_key, next(iter(by_signature)))
        runs._ordinals[first_key] = runs._ordinals.get(first_key, 0) + 1
    return None


# ---------------------------------------------------------------------------------------------
# RuleSets from a snapshot (research D4/D17, FR-028a)
# ---------------------------------------------------------------------------------------------

_TIER_CACHE = {}  # runId -> (mtime, {'CYCLE': RuleSet, 'GLOBAL': RuleSet, 'steps': {stepKey: RuleSet}})


def _build_ruleset(rule_docs, run, engine):
    """A RuleSet built from plain rule documents (a snapshot child's `callRule`, or the run's
    `cycleRules`) - the SAME `interception.Rule`/`_prepare_actions` a published rules.json goes
    through, so every action, including one added after this feature shipped, just works (D17)."""
    limits = {}
    base = engine.global_ruleset()
    relive_variables = run.get('variables') if isinstance(run.get('variables'), dict) else {}
    variables = {**base.variables, **{'$.' + name: value for name, value in relive_variables.items()},
                 **{'$.' + name: value for name, value in interception.relive_overlay(run.get('runId'), run.get('_mtime')).items()}}
    secrets = set(base.secrets) | {'$.' + name for name in (run.get('secrets') or [])}
    rules = []
    for doc in rule_docs:
        if not isinstance(doc, dict):
            continue
        if secrets:
            interception._mark_secret_actions(doc, secrets)
        try:
            rule = interception.Rule(doc, limits)
        except re.error:
            continue
        if rule.enabled and rule.actions:
            rules.append(rule)
    rules.sort(key=lambda r: r.priority)
    return interception.RuleSet(enabled=True, rules=rules, variables=variables,
                                fallbacks=base.fallbacks, secrets=secrets)


def _build_global_ruleset(engine, run):
    """The run's GLOBAL tier: the currently published global rules, filtered by the snapshot's
    `globalRules` (NONE/ALL/SELECTED) - research D4. Sensitive-header/self-target config is
    carried over unchanged, since those are deployment-wide settings, not per-run ones."""
    base = engine.global_ruleset()
    mode = ((run.get('globalRules') or {}).get('mode') or 'NONE').upper()
    if mode == 'NONE' or base.inert:
        rules = []
    elif mode == 'ALL':
        rules = list(base.rules)
    else:  # SELECTED
        selected = set((run.get('globalRules') or {}).get('selectedIds') or [])
        rules = [r for r in base.rules if r.id in selected]
    return interception.RuleSet(
        enabled=True, rules=rules, sensitive=base.sensitive, self_targets=base.self_targets,
        variables=base.variables, fallbacks=base.fallbacks, secrets=base.secrets)


def _relive_answers_dir(run_id, runs=None):
    base_dir = runs._dir if runs is not None else _default_dir()
    return os.path.join(base_dir, 'answers', run_id)


def _set_flow_context(flow, run, step_key):
    flow.metadata['_relive_context'] = {
        'cycleId': run.get('cycleId'), 'runId': run.get('runId'), 'stepKey': step_key,
        'mtime': run.get('_mtime'),
    }


def rulesets_for(engine, run, step_entry, runs=None):
    """The (tierName, RuleSet, answersDir) triples for `engine.apply_request/apply_response`'s
    `extra_rulesets` - STEP (this step/child's own callRule), CYCLE (the run's cycleRules), GLOBAL
    (the participating global rules) - built once per published snapshot and cached by its mtime,
    never rebuilt per call (T030). `step_entry` is either an inbound step (its own callRule) or an
    outbound child - both carry `stepKey` and `callRule` the same way. `runs`, when given, is the
    same ReliveRuns whose directory this run's snapshot was read from - its answers/ subdirectory
    is where the run's stored answers live (contracts/proxy-snapshot.md); defaults to the module's
    own directory for a caller with no ReliveRuns of its own (there should not normally be one).
    """
    run_id = run.get('runId')
    mtime = run.get('_mtime')
    cached = _TIER_CACHE.get(run_id)
    if cached is None or cached[0] != mtime:
        cached = (mtime, {'steps': {}})
        _TIER_CACHE[run_id] = cached
    bag = cached[1]

    if 'CYCLE' not in bag:
        bag['CYCLE'] = _build_ruleset(run.get('cycleRules') or [], run, engine)
    if 'GLOBAL' not in bag:
        bag['GLOBAL'] = _build_global_ruleset(engine, run)

    step_key = (step_entry or {}).get('stepKey')
    if step_key not in bag['steps']:
        call_rule = (step_entry or {}).get('callRule')
        docs = [call_rule] if isinstance(call_rule, dict) and call_rule else []
        bag['steps'][step_key] = _build_ruleset(docs, run, engine)

    answers_dir = _relive_answers_dir(run_id, runs)
    global_answers_dir = engine.answers_dir
    return [
        ('STEP', bag['steps'][step_key], answers_dir),
        ('CYCLE', bag['CYCLE'], answers_dir),
        ('GLOBAL', bag['GLOBAL'], global_answers_dir),
    ]


def _build_unexpected_ruleset(run, engine):
    """unexpectedCalls.rules, first-match-wins (stopProcessing implied - FR-014f), as one tier."""
    docs = (run.get('unexpectedCalls') or {}).get('rules') or []
    ruleset = _build_ruleset(docs, run, engine)
    for rule in ruleset.rules:
        rule.stop_processing = True
    return ruleset


# ---------------------------------------------------------------------------------------------
# Verdicts this module builds directly (blocking), rather than through the rule engine
# ---------------------------------------------------------------------------------------------

def _blocked_verdict(status, payload):
    verdict = interception.Verdict()
    verdict.terminal = 'MOCK_RESPONSE'
    verdict.mock = {'status': status, 'headers': {'content-type': 'application/json'},
                     'body': json.dumps(payload)}
    return verdict


def _guard_replay(verdict, step_entry, run_id, step_key):
    """FR-018: a REPLAY child (or inbound step) whose call rule's stored answer is missing or
    unreadable must FAIL, never fall through to the real host. The generic ANSWER_WITH_FILE /
    ANSWER_WITH_RECORDED_CALL actions already refuse to invent a response when their answer is
    missing (interception.py: `verdict.skip(...)`, no terminal set) - which is exactly right for
    ordinary rules, where "let the real call happen" is the safe reading. For a REPLAY step it is
    the opposite: nothing terminal after running its own call rule means its mock or its recorded
    answer could not be produced, so this is the point that turns "fell through" into "blocked"."""
    if (step_entry.get('mode') or '').upper() != 'REPLAY':
        return
    if verdict.terminal:
        return
    verdict.terminal = 'MOCK_RESPONSE'
    verdict.mock = {
        'status': 502,
        'headers': {'content-type': 'application/json'},
        'body': json.dumps({
            'error': 'Blocked by ALFRED Relive - recorded answer unavailable',
            'runId': run_id, 'stepKey': step_key,
        }),
    }


def _tag_changed_pause(verdict, run_id, step_key):
    """Marks a request-phase pause (the call rule's ASK/"request differs" branch, research D15/
    D17) with the metadata breakpoints.py needs to carry to the backend, and the addon needs to
    recognise its unattended-timeout guarantee - see force_failure_mock and T033."""
    if verdict.pause and verdict.pause.get('phase') == 'request':
        verdict.pause['relive'] = {'runId': run_id, 'stepKey': step_key, 'at': 'CHANGED'}


def _rule_applications(flow, rulesets):
    """[{'tier': 'STEP'|'CYCLE'|'GLOBAL', 'ruleId': ..., 'ruleName': ...}, ...] in tier order
    (FR-028/T068) - read straight from the engine's own per-tier matched-rules record
    (`interception.MATCHED_KEY`, set by `_apply_request_phase_tiered`) rather than re-evaluating
    anything: `rulesets` is the exact `(tier_name, ruleset, answers_dir)` list this call's
    `apply_request` was given, in the same order the engine iterated it in, so zipping the two
    together recovers which tier each matched rule came from. Request-phase only - a rule that only
    ever changes the response is not reflected here."""
    matched = (getattr(flow, 'metadata', None) or {}).get(interception.MATCHED_KEY)
    if not matched or matched[0] != 'TIERED':
        return []
    tiers_matched = matched[1]
    out = []
    for (tier_name, _ruleset, _dir), (_tier_ruleset, matching) in zip(rulesets, tiers_matched):
        for rule in matching:
            out.append({'tier': tier_name, 'ruleId': rule.id, 'ruleName': rule.name})
    return out


def failure_payload(relive_meta):
    """The body for the 502 an unattended "request differs" pause resolves to - see
    force_failure_mock, called from the addon once `breakpoints.wait_for_decision` comes back
    with no real human decision (a timeout, a dropped connection, or no webhook configured at
    all)."""
    return {
        'error': 'Blocked by ALFRED Relive - no decision on a changed request',
        'runId': relive_meta.get('runId'),
        'stepKey': relive_meta.get('stepKey'),
    }


# ---------------------------------------------------------------------------------------------
# Outbound (log_and_route.py)
# ---------------------------------------------------------------------------------------------

async def apply_outbound(flow, service_name, backend_addresses, engine, runs=None):
    """The Relive half of log_and_route.py's request(): attribution, then whichever policy
    applies. Returns (verdict, info):
      - verdict is None when Relive has nothing to say about this call - the caller runs its
        ordinary `engine.apply_request(flow, service_name)` (global rules only, ND4) exactly as
        before this feature existed;
      - otherwise verdict is a fully-formed Verdict (blocked, or the tiered rules' outcome) the
        caller uses AS the request's verdict - it already includes the GLOBAL tier, so the caller
        must not also run the plain engine call in that case.
    `info`, when not None, is the `relive` dict for flow.metadata / the logged call (FR-051).
    """
    runs = runs or _default_runs()
    result = attribute(flow, 'outbound', service_name, backend_addresses, runs)

    if result.kind == 'AMBIGUOUS':
        info = {'ambiguousRunIds': result.ambiguous_run_ids, 'attribution': 'AMBIGUOUS'}
        return _blocked_verdict(502, {
            'error': 'Blocked by ALFRED Relive - claimed by more than one run',
            'runIds': result.ambiguous_run_ids,
        }), info

    if result.kind == 'UNATTRIBUTED':
        return await _handle_unattributed(flow, service_name, engine, runs)

    run = result.run
    run_id = run.get('runId')
    parent_step_key = result.step_key

    if _is_stopping(run):
        # STOPPING: no call rule or policy of the run runs at all - see
        # contracts/proxy-snapshot.md. `consume=False` so a call about to be blocked doesn't use
        # up an ordinal slot a still-running sibling call needs.
        child = match_child(flow, 'outbound', service_name, run, parent_step_key, runs, consume=False)
        step_key = child.get('stepKey') if child else parent_step_key
        return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive - run stopping', 'runId': run_id}), \
            {'runId': run_id, 'stepKey': step_key, 'attribution': result.kind, 'choice': 'STOPPING'}

    child = match_child(flow, 'outbound', service_name, run, parent_step_key, runs, consume=True)
    if child is None:
        return await _handle_unexpected(flow, service_name, engine, run, runs)

    rulesets = rulesets_for(engine, run, child, runs)
    flow.metadata['relive_rulesets'] = rulesets
    _set_flow_context(flow, run, child.get('stepKey'))
    verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
    _guard_replay(verdict, child, run_id, child.get('stepKey'))
    _tag_changed_pause(verdict, run_id, child.get('stepKey'))
    info = {'runId': run_id, 'stepKey': child.get('stepKey'), 'attribution': result.kind,
            'choice': child.get('mode'), 'ruleIds': _rule_applications(flow, rulesets)}
    return verdict, info


async def _handle_unattributed(flow, service_name, engine, runs):
    matches = _match_unattributed_all(flow, 'outbound', service_name, runs)
    if not matches:
        return None, None

    stopping = [(r, c) for r, c in matches if _is_stopping(r)]
    if stopping:
        run = stopping[0][0]
        return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive - run stopping',
                                       'runId': run.get('runId')}), \
            {'runId': run.get('runId'), 'attribution': 'UNATTRIBUTED', 'choice': 'STOPPING'}

    if len({r.get('runId') for r, c in matches}) > 1:
        run_ids = sorted({r.get('runId') for r, c in matches})
        return _blocked_verdict(502, {
            'error': 'Blocked by ALFRED Relive - claimed by more than one run',
            'runIds': run_ids,
        }), {'ambiguousRunIds': run_ids, 'attribution': 'AMBIGUOUS'}

    run, child = matches[0]
    run_id = run.get('runId')
    choice = (child.get('unattributed') or 'BLOCK').upper()
    info = {'runId': run_id, 'stepKey': child.get('stepKey'), 'attribution': 'UNATTRIBUTED', 'choice': choice}

    if choice == 'SEND_REAL':
        return None, info

    if choice == 'REPLAY_ANYWAY':
        # Applies the child's own call rule "as if attributed" (FR-049a) - still bound by the
        # very same REPLAY guard as an ordinary attributed call: no answer, no forward.
        rulesets = rulesets_for(engine, run, child, runs)
        flow.metadata['relive_rulesets'] = rulesets
        _set_flow_context(flow, run, child.get('stepKey'))
        verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
        _guard_replay(verdict, child, run_id, child.get('stepKey'))
        _tag_changed_pause(verdict, run_id, child.get('stepKey'))
        info['ruleIds'] = _rule_applications(flow, rulesets)
        return verdict, info

    # BLOCK (default)
    return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive - unattributed'}), info


async def _handle_unexpected(flow, service_name, engine, run, runs):
    policy_block = run.get('unexpectedCalls') or {}
    policy = (policy_block.get('policy') or 'BLOCK').upper()
    run_id = run.get('runId')
    info = {'runId': run_id, 'attribution': 'UNEXPECTED', 'unexpected': True}

    if policy == 'SEND_REAL':
        return None, info

    if policy == 'RULES':
        unexpected_ruleset = _build_unexpected_ruleset(run, engine)
        answers_dir = _relive_answers_dir(run_id, runs)
        rulesets = [('STEP', unexpected_ruleset, answers_dir)]
        # Cycle/global rules still apply after, as in D4 - reuse the same cached CYCLE/GLOBAL
        # tiers a matched child would use (they don't depend on which child, if any, matched).
        for tier_name, tier_ruleset, tier_dir in rulesets_for(engine, run, None, runs)[1:]:
            rulesets.append((tier_name, tier_ruleset, tier_dir))
        flow.metadata['relive_rulesets'] = rulesets
        _set_flow_context(flow, run, None)
        verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
        if not verdict.terminal:
            fallback = (policy_block.get('fallback') or 'BLOCK').upper()
            if fallback == 'SEND_REAL':
                return None, info
            verdict = _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive', 'runId': run_id})
        return verdict, info

    # BLOCK (default)
    return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive', 'runId': run_id}), info


# ---------------------------------------------------------------------------------------------
# Inbound (log_and_route_reverse.py)
# ---------------------------------------------------------------------------------------------

async def apply_inbound(flow, service_name, backend_addresses, engine, runs=None):
    """The Relive half of log_and_route_reverse.py's request(). Automatic runs are attributed
    exactly (HEADER: backend-resend tags every step it sends). A Guided run has no header - the
    user's own browser is calling in - so it claims an untagged call only when it is the SOLE
    active Guided run for this project (research D2's Guided note); anything else (no run, more
    than one Guided run for the project) is left to the caller's ordinary, non-Relive handling.
    """
    runs = runs or _default_runs()
    header_run_id, header_step_key = _take_header(flow, backend_addresses)
    if header_run_id:
        run = runs.get(header_run_id)
        if run is not None:
            return await _apply_matched_step(flow, service_name, engine, run, header_step_key, 'HEADER', runs)

    guided = [r for r in runs.active_runs().values()
              if (r.get('driver') or '').upper() == 'GUIDED' and service_name in (r.get('projects') or [])]
    if len(guided) == 1:
        return await _apply_matched_step(flow, service_name, engine, guided[0], None, 'GUIDED', runs)

    return None, None


async def _apply_matched_step(flow, service_name, engine, run, step_key, attribution, runs):
    run_id = run.get('runId')
    if _is_stopping(run):
        return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive - run stopping', 'runId': run_id}), \
            {'runId': run_id, 'stepKey': step_key, 'attribution': attribution, 'choice': 'STOPPING'}

    step = _find_step(run, step_key) if step_key else None
    if step is None:
        if step_key:
            # A stale/broken stepKey reference - nothing to enforce, nothing useful to log either.
            return None, None
        # Guided (research D2, T077): nothing matched yet - Relive has nothing to enforce on this
        # call (it passes through unmarked, rule-wise), but it's still logged as this run's own so
        # the frontend can match it to the next expected step itself, over `/ws/relive`.
        return None, {'runId': run_id, 'stepKey': None, 'attribution': attribution, 'choice': None}

    rulesets = rulesets_for(engine, run, step, runs)
    flow.metadata['relive_rulesets'] = rulesets
    _set_flow_context(flow, run, step.get('stepKey'))
    verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
    _tag_changed_pause(verdict, run_id, step.get('stepKey'))
    info = {'runId': run_id, 'stepKey': step.get('stepKey'), 'attribution': attribution,
            'choice': step.get('mode'), 'ruleIds': _rule_applications(flow, rulesets)}
    return verdict, info
