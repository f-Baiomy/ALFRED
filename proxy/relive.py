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

import hashlib
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
        # Per-run, per-parent-step, per-endpoint-signature ordinal counters (research D3).
        # One inbound execution owns them. A new in-flight call id for that step (Retry,
        # checkpoint replay, a resend) starts them over; a second supplier call inside the
        # same execution does not. The forward proxy sees the new execution only via inflight.json.
        self._ordinals = {}
        self._ordinal_epoch = {}  # (run_id, parent_step_key) -> inflight callId
        self._steps_by_run = {}   # runId -> {stepKey: step node}, built when the snapshot is loaded
        self._forced_for = set()  # unknown run ids already given a forced scan this window
        self._guided = {}         # runId -> (top-step index, stepKey, monotonic time) last matched
        self._used = {}           # (runId, parent stepKey) -> child stepKeys already matched this execution

    def _stale(self):
        now = time.monotonic()
        if self._last_check is None or now - self._last_check >= REFRESH_INTERVAL_SECONDS:
            self._last_check = now
            return True
        return False

    def refresh(self, force=False):
        if self._stale():
            self._forced_for = set()
            self._refresh_run_files()
        elif force:
            self._refresh_run_files()
        # Inflight changes on every inbound send. The run-file scan stays throttled; this stat
        # does not, or a retry inside the throttle window still sees the previous execution.
        self._reload_inflight_if_changed()

    def _refresh_run_files(self):
        try:
            names = os.listdir(self._dir)
        except OSError:
            # No directory: Relive has never run here, or has just been cleaned up. Reset so a
            # directory that reappears later (a new run starting) is read fresh, not left showing
            # whatever the last successful listing saw.
            if self._runs or self._inflight or self._file_mtimes or self._ordinals or self._ordinal_epoch or self._steps_by_run:
                self._runs = {}
                self._inflight = {}
                self._file_mtimes = {}
                self._ordinals = {}
                self._ordinal_epoch = {}
                self._steps_by_run = {}
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
                self._steps_by_run.pop(run_id, None)
                self._forget_ordinals(run_id)
                continue
            snapshot.setdefault('runId', run_id)
            snapshot['_mtime'] = mtime
            self._runs[run_id] = snapshot
            self._steps_by_run[run_id] = _step_index(snapshot)

        for stale_name in [n for n in self._file_mtimes if n != 'inflight.json' and n not in seen]:
            del self._file_mtimes[stale_name]
            run_id = stale_name[:-len('.json')]
            self._runs.pop(run_id, None)
            self._steps_by_run.pop(run_id, None)
            self._forget_ordinals(run_id)

    def _reload_inflight_if_changed(self):
        inflight_path = os.path.join(self._dir, 'inflight.json')
        try:
            mtime = os.path.getmtime(inflight_path)
        except OSError:
            self._inflight = {}
            self._file_mtimes.pop('inflight.json', None)
            return
        if self._file_mtimes.get('inflight.json') == mtime:
            return
        self._file_mtimes['inflight.json'] = mtime
        loaded = self._load_json(inflight_path) or {}
        projects = loaded.get('projects') if isinstance(loaded, dict) else None
        self._inflight = projects if isinstance(projects, dict) else {}

    def _forget_ordinals(self, run_id):
        interception.clear_relive_overlay(run_id)
        self._guided.pop(run_id, None)
        for key in [k for k in self._ordinals if k[0] == run_id]:
            del self._ordinals[key]
        for key in [k for k in self._ordinal_epoch if k[0] == run_id]:
            del self._ordinal_epoch[key]
        for key in [k for k in self._used if k[0] == run_id]:
            del self._used[key]

    def _forget_step_ordinals(self, run_id, parent_step_key):
        for key in [k for k in self._ordinals if k[0] == run_id and k[1] == parent_step_key]:
            del self._ordinals[key]
        self._used.pop((run_id, parent_step_key), None)

    def _load_json(self, path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def active_runs(self):
        self.refresh()
        return self._runs

    def ensure_known(self, run_ids):
        """Re-list the run files now when a run id is named that this process has not loaded.

        The run-file scan is throttled to once a second, but the backend publishes a run and its
        first inflight entry within milliseconds of each other. Without this, a supplier call made
        in that window sees no run and goes to the real host.
        """
        missing = {run_id for run_id in run_ids
                   if run_id and run_id not in self._runs and run_id not in self._forced_for}
        if missing:
            # Each unknown id forces one scan per throttle window, not one per call: an id that
            # names a run already gone (a stale inflight entry) must not cost a listing every call.
            self._forced_for |= missing
            self.refresh(force=True)
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


def _walk_steps(steps):
    for step in steps or []:
        yield step
        yield from _walk_steps(step.get('children'))


def _step_index(run):
    """stepKey → node, including nested children. Built once when the snapshot is loaded."""
    found = {}
    for step in _walk_steps(run.get('steps') if isinstance(run, dict) else None):
        if not isinstance(step, dict):
            continue
        key = step.get('stepKey')
        if key and key not in found:
            found[key] = step
    return found


def _steps_for(run, runs=None):
    if not isinstance(run, dict):
        return {}
    if runs is not None:
        cached = getattr(runs, '_steps_by_run', {}).get(run.get('runId'))
        if isinstance(cached, dict):
            return cached
    cached = run.get('_steps_by_key')
    if isinstance(cached, dict):
        return cached
    built = _step_index(run)
    if runs is not None and run.get('runId'):
        runs._steps_by_run[run.get('runId')] = built
    else:
        run['_steps_by_key'] = built
    return built


def _find_step(run, step_key, runs=None):
    """A step anywhere in the tree. A child can itself be an inbound call with children."""
    if not step_key:
        return None
    return _steps_for(run, runs).get(step_key)


def _child_enabled(child):
    """A snapshot written before enablement was published leaves the field off, and stays selectable."""
    return isinstance(child, dict) and child.get('enabled') is not False


def _parent_keys(run):
    parents = {}

    def walk(step, parent_key):
        key = step.get('stepKey')
        if key:
            parents[key] = parent_key
        for child in step.get('children') or []:
            walk(child, key)

    for step in run.get('steps') or []:
        walk(step, None)
    return parents


def _is_under(parents, ancestor, key):
    current = parents.get(key)
    seen = set()
    while current and current not in seen:
        if current == ancestor:
            return True
        seen.add(current)
        current = parents.get(current)
    return False


def _child_match_raw(child):
    call_rule = child.get('callRule')
    if isinstance(call_rule, dict) and call_rule.get('match'):
        return call_rule.get('match')
    return child.get('match')


def _match_signature(child):
    return json.dumps(_child_match_raw(child) or {}, sort_keys=True)


def _is_replay_step(step_entry):
    """A child answers from the recording.

    A current snapshot has no mode field: an enabled MOCK_RESPONSE is the replay. An older
    child (and the proxy tests) still set mode REPLAY and answer with ANSWER_WITH_FILE, which
    has no MOCK_RESPONSE of its own. Either signal means a missing answer must block, never
    fall through to the real host.
    """
    if not isinstance(step_entry, dict):
        return False
    if str(step_entry.get('mode') or '').upper() == 'REPLAY':
        return True
    rule = step_entry.get('callRule')
    actions = rule.get('actions') if isinstance(rule, dict) else []
    return any(isinstance(action, dict) and action.get('type') == 'MOCK_RESPONSE'
               and action.get('enabled') is not False for action in (actions or []))

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
        for step in _walk_steps(run.get('steps')):
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


def _inflight_entries(runs, service_name):
    """In-flight calls that can own this request.

    A project-specific listener uses that project's own entries. A call on the shared
    listener has no project name, and an inbound child arrives on its own project, which
    is not the project of the call that caused it. Either way the recorded tree is what
    relates them: every in-flight step is a candidate, and the deepest one wins.
    X-Operation-Id is not required — the application does not always forward it.
    """
    if service_name:
        scoped = runs.inflight_for(service_name)
        if scoped:
            return scoped
    else:
        runs.refresh()
    entries = []
    for project_entries in (runs._inflight or {}).values():
        if isinstance(project_entries, list):
            entries.extend(entry for entry in project_entries if isinstance(entry, dict))
    return entries


def _is_outbound_entry(run, entry, runs):
    """An in-flight entry for an outbound call never owns another call.

    Only an inbound execution has outbound children. An older backend also listed each supplier
    call while it was in flight, which made a sibling made at the same time look like that
    supplier's own child - and so unexpected.
    """
    if (entry.get('direction') or '').lower() == 'outbound':
        return True
    step = _find_step(run, entry.get('stepKey'), runs)
    return step is not None and (step.get('direction') or '').lower() == 'outbound'


def _deepest_inflight_entry(run, entries):
    """The in-flight step that is not an ancestor of another in-flight step of this run.

    odeysys containing core-service is one chain: the supplier call belongs to
    core-service, the same way the frontend's call tree picks the innermost owner.
    Two in-flight steps that do not contain each other are ambiguous.
    """
    parents = _parent_keys(run)
    by_key = {}
    for entry in entries:
        key = entry.get('stepKey')
        if key:
            by_key[key] = entry
    keys = list(by_key)
    leaves = [key for key in keys if not any(_is_under(parents, key, other) for other in keys if other != key)]
    if len(leaves) != 1:
        return None
    return by_key[leaves[0]]


def attribute(flow, source, service_name, backend_addresses, runs=None):
    """Which Relive run (if any) an OUTBOUND call belongs to - research D2, in order:
    HEADER -> OPERATION_ID -> INFLIGHT -> AMBIGUOUS -> UNATTRIBUTED. Returns an AttributionResult.

    `runs` lets the addon (and tests) share one ReliveRuns instance; a fresh one is created, and
    so costs one failed directory listing, when the caller has none to share."""
    runs = runs or _default_runs()
    active = runs.active_runs()

    header_run_id, header_step_key = _take_header(flow, backend_addresses)
    inflight_ids = {e.get('runId') for entries in (runs._inflight or {}).values()
                    if isinstance(entries, list) for e in entries if isinstance(e, dict)}
    active = runs.ensure_known({header_run_id, *inflight_ids} - {None})
    if header_run_id and header_run_id in active:
        return AttributionResult('HEADER', active[header_run_id], header_step_key)

    op_run_id, op_step_key = _take_operation_id(flow, active)
    if op_run_id:
        return AttributionResult('OPERATION_ID', active[op_run_id], op_step_key)

    if not active:
        # No run at all: nothing left to check, and nothing more to read from disk this call -
        # see ReliveRuns.refresh, which already made that cheap.
        return AttributionResult('UNATTRIBUTED')

    entries = _inflight_entries(runs, service_name)
    with_run = [e for e in entries if e.get('runId') in active
                and not _is_outbound_entry(active[e.get('runId')], e, runs)]
    in_flight_run_ids = {e['runId'] for e in with_run}

    if len(in_flight_run_ids) > 1:
        return AttributionResult('AMBIGUOUS', ambiguous_run_ids=sorted(in_flight_run_ids))

    if len(in_flight_run_ids) == 1:
        # The supplier call belongs to the inbound that is in flight. Its outbound children
        # are compared below; the rest of the cycle is not scanned.
        run_id = next(iter(in_flight_run_ids))
        run = active[run_id]
        own = [e for e in with_run if e.get('runId') == run_id]
        keyed = [e for e in own if e.get('stepKey')]
        if not keyed:
            # A Guided inbound call that matched no step is still this run's: its outbound calls
            # are unexpected calls of the run (its policy decides), not claimed by several runs.
            return AttributionResult('INFLIGHT', run, None)
        chosen = _deepest_inflight_entry(run, keyed)
        if chosen is None:
            return AttributionResult('AMBIGUOUS', ambiguous_run_ids=[run_id])
        return AttributionResult('INFLIGHT', run, chosen.get('stepKey'))

    matching_run_ids = _runs_with_matching_outbound_child(flow, source, service_name, active)
    if len(matching_run_ids) > 1:
        return AttributionResult('AMBIGUOUS', ambiguous_run_ids=sorted(matching_run_ids))

    return AttributionResult('UNATTRIBUTED')


def _match_unattributed_all(flow, source, service_name, runs):
    """Every (run, child) pair whose REPLAY child matches an UNATTRIBUTED call - used for the
    unattributed choice (FR-049a) and for detecting the "claimed by more than one run" case even
    when in-flight uniqueness didn't (a request can match a child of a run with no in-flight
    inbound call at all, e.g. a stale or misconfigured match)."""
    request, host, path = _request_host_path(flow)
    found = []
    for run in runs.active_runs().values():
        for step in _walk_steps(run.get('steps')):
            for child in step.get('children') or []:
                if not _is_replay_step(child):
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


def _child_is_inbound(child):
    direction = (child.get('direction') or '').lower()
    if direction == 'inbound':
        return True
    if direction == 'outbound':
        return False
    source = ((_child_match_raw(child) or {}).get('source') or '').lower()
    return source == 'inbound'


def _outbound_candidates(step):
    """Outbound calls that belong to this inbound, and not to any other step in the cycle.

    Direct outbound children, plus the outbound calls under a nested inbound (a supplier
    behind an inbound child). A nested inbound is not itself a candidate: it is claimed on
    the reverse proxy, and while it is the in-flight step its own children are the set.
    """
    found = []

    def walk(node):
        for child in node.get('children') or []:
            if _child_is_inbound(child):
                walk(child)
            else:
                found.append(child)
                if child.get('children'):
                    walk(child)

    walk(step)
    return found


def _live_endpoint(request):
    try:
        query = getattr(request, 'query', None) or {}
    except Exception:
        query = {}
    return interception.canonical_endpoint(
        getattr(request, 'method', None),
        getattr(request, 'scheme', None),
        getattr(request, 'pretty_host', None) or getattr(request, 'host', None),
        getattr(request, 'path', None),
        query,
    )


def _child_endpoint(child):
    """The recorded URL, or None when this child only has a loose path/host match."""
    rec = child.get('recordedRequest') if isinstance(child.get('recordedRequest'), dict) else {}
    path = rec.get('path') or ''
    if not path:
        return None
    match = _child_match_raw(child) or {}
    method = rec.get('method') or ((match.get('methods') or [None])[0])
    host = rec.get('host') or ''
    if not host:
        raw_host = match.get('host') or ''
        host = '' if '*' in raw_host else raw_host
    return interception.canonical_endpoint(method, rec.get('scheme'), host, path, rec.get('query') or '')


def _request_differs(flow, child, runs, run):
    """Whether this call's request (as it stands after the call rule's own edits) differs from the
    child's recording - the same test as the call rule's "request differs" condition. None when the
    child has no such condition to answer it."""
    answer_id = _recorded_answer_id(child)
    if not answer_id:
        return None
    condition = interception.Condition({'subject': 'RECORDED_CALL', 'operator': 'MATCHES', 'answerId': answer_id})
    saved = flow.metadata.get('_interception_answer_dir')
    flow.metadata['_interception_answer_dir'] = _relive_answers_dir(run.get('runId'), runs)
    try:
        return not condition._recorded_call_holds(flow)
    finally:
        flow.metadata['_interception_answer_dir'] = saved


def _recorded_answer_id(child):
    rule = child.get('callRule') if isinstance(child.get('callRule'), dict) else None
    for action in (rule or {}).get('actions') or []:
        if not isinstance(action, dict) or action.get('type') != 'IF_REQUEST':
            continue
        for branch in action.get('branches') or []:
            for cond in (branch or {}).get('conditions') or []:
                if str((cond or {}).get('subject') or '').upper() == 'RECORDED_CALL':
                    answer_id = str((cond or {}).get('answerId') or '').strip()
                    if answer_id:
                        return answer_id
    return None


def _recorded_for_child(child, runs, run):
    """The child's recorded request, indexed once. None when this child has no body on file
    — the caller then keeps the host/path match and lets the call rule decide."""
    answer_id = _recorded_answer_id(child)
    if answer_id:
        recorded = interception._load_recorded_request(_relive_answers_dir(run.get('runId'), runs), answer_id)
        if recorded:
            return recorded
    rec = child.get('recordedRequest') if isinstance(child.get('recordedRequest'), dict) else None
    if rec and ('body' in rec or 'headers' in rec):
        cached = rec.get('body_canonical')
        if cached is None:
            interception.index_recorded_request(rec)
        return rec
    return None


def _same_recorded_request(request, recorded, cache):
    """Stable headers and canonical body. The live side is parsed once per request (`cache`)."""
    if 'headers' not in cache:
        cache['headers'] = interception.stable_header_items(getattr(request, 'headers', {}) or {})
    recorded_headers = recorded.get('stable_headers')
    if recorded_headers is None:
        recorded_headers = interception.stable_header_items(recorded.get('headers') or {})
    if cache['headers'] != recorded_headers:
        return False
    if 'body' not in cache:
        cache['body'] = interception.canonical_body(interception._body(request) or '')
    recorded_body = recorded.get('body_canonical')
    if recorded_body is None:
        recorded_body = interception.canonical_body(recorded.get('body') or '')
    return cache['body'] == recorded_body


FINGERPRINT_VERSION = 'SEMANTIC_V1'


def semantic_fingerprint_v1(endpoint, stable_headers, body_canonical):
    """SHA-256 of a canonical request. The same bytes as Java RequestFingerprint.

    endpoint is (method, scheme, host, path, query). stable_headers is sorted
    (name, value) pairs. body_canonical is interception.canonical_body output.
    Stored steps keep this hash. A replay run hashes only the live request.
    """
    digest = hashlib.sha256()
    digest.update(b'SEMANTIC_V1')
    digest.update(b'\0')
    for item in endpoint:
        digest.update((item or '').encode('utf-8'))
        digest.update(b'\0')
    digest.update(b'\0')
    for name, value in stable_headers:
        digest.update(name.encode('utf-8'))
        digest.update(b'\0')
        digest.update((value or '').encode('utf-8'))
        digest.update(b'\0')
    digest.update(b'\0')
    digest.update((body_canonical or '').encode('utf-8'))
    return digest.hexdigest()


def _live_semantic_fingerprint(request, cache):
    token = cache.get('semantic')
    if token is not None:
        return token
    if 'headers' not in cache:
        cache['headers'] = interception.stable_header_items(getattr(request, 'headers', {}) or {})
    if 'body' not in cache:
        cache['body'] = interception.canonical_body(interception._body(request) or '')
    token = semantic_fingerprint_v1(_live_endpoint(request), cache['headers'], cache['body'])
    cache['semantic'] = token
    return token


def _fingerprint(recorded, endpoint):
    token = recorded.get('_fp')
    if token:
        return token
    digest = hashlib.sha256()
    digest.update(repr(endpoint).encode('utf-8'))
    digest.update(b'\0')
    digest.update(repr(recorded.get('stable_headers')).encode('utf-8'))
    digest.update(b'\0')
    digest.update((recorded.get('body_canonical') or '').encode('utf-8'))
    token = digest.hexdigest()
    recorded['_fp'] = token
    return token


def _legacy_child_match(child, source, service_name, request, host, path):
    match_raw = _child_match_raw(child)
    if not match_raw:
        return False
    try:
        return interception.Match(match_raw).matches(
            source, service_name, request.method, host, path, request, None)
    except Exception:
        return False


def _take_ordinal(by_signature, run_id, parent_step_key, runs, consume):
    """The next unused child in a fingerprint group.

    Children that share a fingerprint are the same call recorded more than once, so they are
    taken in ordinal order. A child whose body differs is a different group and is not blocked
    by a sibling's ordinal.
    """
    for signature, children in by_signature.items():
        ordered = sorted(children, key=lambda child: child.get('ordinal') or 1)
        key = (run_id, parent_step_key, signature)
        used = runs._ordinals.get(key, 0)
        if used < len(ordered):
            if consume:
                runs._ordinals[key] = used + 1
            return ordered[used]
    if by_signature and consume:
        first_key = (run_id, parent_step_key, next(iter(by_signature)))
        runs._ordinals[first_key] = runs._ordinals.get(first_key, 0) + 1
    return None


def _take_in_stored_order(children, run_id, parent_step_key, signature, runs, consume):
    """The index lists keys in cycle order. That order is the order they are consumed.

    Nested calls reset the snapshot ordinal at 1, so sorting by ordinal would disagree with
    the stored list. The legacy scan still sorts; this path does not.
    """
    if not children:
        return None
    key = (run_id, parent_step_key, signature)
    used = runs._ordinals.get(key, 0)
    if used < len(children):
        if consume:
            runs._ordinals[key] = used + 1
        return children[used]
    if consume:
        runs._ordinals[key] = used + 1
    return None


def _sync_ordinal_epoch(runs, run_id, parent_step_key):
    """Start child ordinals over when this parent step is executing again.

    Retry, an after-checkpoint replay, and a resend each publish a new inflight call id for the
    same step key. The forward proxy never sees that inbound request; inflight.json is the shared
    signal. A second supplier call that still belongs to the current call id keeps the spent slot
    and stays unexpected.
    """
    if runs is None or not run_id or not parent_step_key:
        return
    runs._reload_inflight_if_changed()
    call_id = None
    for entries in (runs._inflight or {}).values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if entry.get('runId') == run_id and entry.get('stepKey') == parent_step_key and entry.get('callId'):
                call_id = entry.get('callId')
    if not call_id:
        return
    epoch_key = (run_id, parent_step_key)
    previous = runs._ordinal_epoch.get(epoch_key)
    if previous == call_id:
        return
    runs._ordinal_epoch[epoch_key] = call_id
    if previous is not None:
        runs._forget_step_ordinals(run_id, parent_step_key)


def _index_step_keys(value):
    if not isinstance(value, list):
        return []
    return [key for key in value if key]


def _indexed_step_keys(index):
    keys = set()
    if not isinstance(index, dict):
        return keys
    for listed in index.values():
        if isinstance(listed, list):
            keys.update(key for key in listed if key)
    return keys


def _consider_unindexed(child, source, service_name, request, host, path, live_ep, runs, run, cache,
                        by_signature, endpoint_only):
    """A child the index does not name. Semantic hashes compare as strings; everyone else may read the answer."""
    recorded_ep = _child_endpoint(child)
    stored_fp = child.get('fingerprint')
    if child.get('fingerprintVersion') == FINGERPRINT_VERSION and stored_fp and recorded_ep is not None:
        if not interception.endpoints_match(live_ep, recorded_ep):
            return
        if stored_fp == _live_semantic_fingerprint(request, cache):
            by_signature.setdefault(stored_fp, []).append(child)
        else:
            endpoint_only.append(child)
        return
    if recorded_ep is None:
        if _legacy_child_match(child, source, service_name, request, host, path):
            by_signature.setdefault(_match_signature(child), []).append(child)
        return
    if not interception.endpoints_match(live_ep, recorded_ep):
        return
    recorded = _recorded_for_child(child, runs, run)
    if recorded is not None and not _same_recorded_request(request, recorded, cache):
        endpoint_only.append(child)
        return
    signature = _fingerprint(recorded, recorded_ep) if recorded is not None else _match_signature(child)
    by_signature.setdefault(signature, []).append(child)


def _finish_scan(by_signature, endpoint_only, run_id, parent_step_key, runs, consume):
    chosen = _take_ordinal(by_signature, run_id, parent_step_key, runs, consume)
    if chosen is not None:
        return chosen
    if by_signature:
        return None
    return _take_by_endpoint(endpoint_only, run_id, parent_step_key, runs)


def _take_by_endpoint(endpoint_only, run_id, parent_step_key, runs):
    """Same URL, but the body or headers differ from every recording: endpoint + order (FR-014a).

    The next same-URL child not matched yet in this execution, in recorded order, gets the call;
    its call rule's "request differs" branch then decides. Several suppliers behind one SOAP URL
    used to make every such call unexpected (blocked) instead. A lone same-URL child keeps taking
    repeats, so a retry still reaches that child's rule.
    """
    if not endpoint_only:
        return None
    used = runs._used.get((run_id, parent_step_key), set()) if runs is not None else set()
    for child in endpoint_only:
        if child.get('stepKey') not in used:
            return child
    return endpoint_only[0] if len(endpoint_only) == 1 else None


def match_child(flow, source, service_name, run, parent_step_key, runs, consume=True):
    child = _match_child(flow, source, service_name, run, parent_step_key, runs, consume)
    if child is not None and consume and runs is not None:
        runs._used.setdefault((run.get('runId'), parent_step_key), set()).add(child.get('stepKey'))
    return child


def _match_child(flow, source, service_name, run, parent_step_key, runs, consume=True):
    """The outbound child of the in-flight inbound this call matches.

    Only that inbound's outbound children are considered — never every outbound call in the
    cycle. A disabled child is never selected. A snapshot that omits `enabled` still is.

    When the in-flight step carries fingerprintIndex, the live request is fingerprinted once
    and that hash is looked up. A hit resolves only the keys stored for it, in that stored
    order, and returns. It does not walk other hashes or children the index left out, and it
    does not read their answer bodies. A miss may still attach the single same-URL indexed
    child, then scan only the children the index does not name.

    A snapshot with no index keeps the full scan, taken in ordinal order. `consume=False` peeks.
    """
    step = _find_step(run, parent_step_key, runs)
    if step is None:
        return None
    _sync_ordinal_epoch(runs, run.get('runId'), parent_step_key)
    request, host, path = _request_host_path(flow)
    live_ep = _live_endpoint(request)
    run_id = run.get('runId')
    cache = {}
    index = step.get('fingerprintIndex') if isinstance(step.get('fingerprintIndex'), dict) else None

    if index is not None:
        live_fp = _live_semantic_fingerprint(request, cache)
        bucket = index.get(live_fp)
        if isinstance(bucket, list) and _index_step_keys(bucket):
            by_key = _steps_for(run, runs)
            ordered = []
            for step_key in _index_step_keys(bucket):
                child = by_key.get(step_key)
                if not _child_enabled(child):
                    continue
                recorded_ep = _child_endpoint(child)
                if recorded_ep is not None and not interception.endpoints_match(live_ep, recorded_ep):
                    continue
                ordered.append(child)
            return _take_in_stored_order(ordered, run_id, parent_step_key, live_fp, runs, consume)

        by_key = _steps_for(run, runs)
        indexed = _indexed_step_keys(index)
        endpoint_only = []
        for step_keys in index.values():
            for step_key in _index_step_keys(step_keys):
                child = by_key.get(step_key)
                if not _child_enabled(child):
                    continue
                recorded_ep = _child_endpoint(child)
                if recorded_ep is not None and interception.endpoints_match(live_ep, recorded_ep):
                    endpoint_only.append(child)
        by_signature = {}
        for child in _outbound_candidates(step):
            if not _child_enabled(child) or child.get('stepKey') in indexed:
                continue
            _consider_unindexed(child, source, service_name, request, host, path, live_ep, runs, run,
                                cache, by_signature, endpoint_only)
        return _finish_scan(by_signature, endpoint_only, run_id, parent_step_key, runs, consume)

    by_signature = {}
    endpoint_only = []
    for child in _outbound_candidates(step):
        if not _child_enabled(child):
            continue
        _consider_unindexed(child, source, service_name, request, host, path, live_ep, runs, run,
                            cache, by_signature, endpoint_only)
    return _finish_scan(by_signature, endpoint_only, run_id, parent_step_key, runs, consume)


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
        _mark_differs_pauses(doc.get('actions'))
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


def _has_recorded_call_condition(action):
    for branch in action.get('branches') or []:
        for cond in (branch or {}).get('conditions') or []:
            if str((cond or {}).get('subject') or '').upper() == 'RECORDED_CALL':
                return True
    return False


def _mark_differs_pauses(actions):
    """Marks the "Ask me" pause of a call rule's request-differs branch (the `otherwise` of an
    IF_REQUEST testing RECORDED_CALL). Only that pause is a request-changed hold; a checkpoint's
    PAUSE_REQUEST is a plain pause that continues on timeout (FR-035d)."""
    for action in actions or []:
        if not isinstance(action, dict):
            continue
        if action.get('type') == 'IF_REQUEST' and _has_recorded_call_condition(action):
            for inner in action.get('otherwise') or []:
                if isinstance(inner, dict) and inner.get('type') == 'PAUSE_REQUEST':
                    inner['reliveAt'] = 'CHANGED'
        for branch in action.get('branches') or []:
            _mark_differs_pauses((branch or {}).get('actions'))
        _mark_differs_pauses(action.get('otherwise'))


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


def _set_flow_context(flow, run, step_key, step=None):
    flow.metadata['_relive_step'] = step
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
    if not _is_replay_step(step_entry):
        return
    if verdict.terminal:
        return
    if verdict.pause and verdict.pause.get('phase') == 'request':
        # Held for a human: the rest of the call rule runs once the pause is settled, and the
        # guard is applied to that outcome (settle_request_pause). Failing here answered every
        # paused REPLAY child with a 502 before anyone could see it.
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
    """Tags a request-phase pause of a run's call with what kind of hold it is: CHANGED for the
    call rule's "request differs" branch (research D15/D17, never forwarded without a human yes),
    BEFORE for a checkpoint (continues with the call's own mode when time runs out)."""
    if verdict.pause and verdict.pause.get('phase') == 'request':
        at = 'CHANGED' if verdict.pause.get('reliveAt') == 'CHANGED' else 'BEFORE'
        verdict.pause['relive'] = {'runId': run_id, 'stepKey': step_key, 'at': at}


def tag_response_pause(flow, response_verdict):
    """A response-phase pause of a run's call is a "pause after" checkpoint: tagged so the run
    view can show it next to the step (FR-035e)."""
    info = (getattr(flow, 'metadata', None) or {}).get('relive') or {}
    if response_verdict.pause and info.get('runId'):
        response_verdict.pause['relive'] = {'runId': info.get('runId'), 'stepKey': info.get('stepKey'), 'at': 'AFTER'}
        # FR-035d: a held answer nobody decides on reaches the application, never a dropped call.
        response_verdict.pause['onTimeout'] = 'release'


def _answer(flow, verdict, status, headers, body):
    from mitmproxy import http
    data = body if isinstance(body, bytes) else (body or '').encode('utf-8')
    flow.response = http.Response.make(status, data, headers or {})
    verdict.terminal = 'MOCK_RESPONSE'
    verdict.mock = {'status': status, 'headers': headers or {}, 'body_bytes': data}


async def settle_request_pause(flow, verdict, decision, service_name, engine):
    """What a released or timed-out request-phase pause of a run's call does next. Returns True
    when the call has been answered here (flow.response set), False when the request goes on to
    the host (after the decision's own request edits).

    A pause stops the call rule in the middle; a plain release used to send the request straight
    to the host and skip the rest of the rule - so a REPLAY child's mock never ran and the real
    supplier was contacted. The rule now carries on after the pause instead.

    decision['relive'] (set by the Relive run view): REPLAY (default), ANSWER (status/headers/body
    are the answer), FAIL, SEND_REAL. A CHANGED hold nobody decided on is the failure mock, never
    the host (T033).
    """
    meta = (verdict.pause or {}).get('relive') or {}
    choice = str(decision.get('relive') or '').upper()
    nobody = bool(decision.get('reason'))
    if meta.get('at') == 'CHANGED' and (nobody or choice == 'FAIL'):
        _answer(flow, verdict, 502, {'content-type': 'application/json'}, json.dumps(failure_payload(meta)))
        return True
    if choice == 'FAIL':
        _answer(flow, verdict, 502, {'content-type': 'application/json'},
                json.dumps({'error': 'Failed by the user at a Relive checkpoint',
                            'runId': meta.get('runId'), 'stepKey': meta.get('stepKey')}))
        return True
    if choice == 'ANSWER':
        _answer(flow, verdict, int(decision.get('status') or 200), decision.get('headers') or {}, decision.get('body') or '')
        return True
    if nobody and meta.get('at') != 'CHANGED':
        choice = 'REPLAY'  # FR-035d: an unanswered checkpoint carries on with the call's own mode
    elif choice == 'SEND_REAL' or (decision.get('action') or '').lower() == 'abort':
        return False
    resume = flow.metadata.pop('_relive_resume', None)
    rulesets = flow.metadata.get('relive_rulesets')
    if resume is None or not rulesets:
        return False
    resumed = await engine.apply_request(flow, service_name, extra_rulesets=rulesets, resume=resume)
    step = flow.metadata.get('_relive_step')
    if step is not None:
        _guard_replay(resumed, step, meta.get('runId'), meta.get('stepKey'))
    if resumed.terminal == 'MOCK_RESPONSE':
        mock = resumed.mock or {}
        body = mock.get('body_bytes')
        _answer(flow, verdict, mock.get('status', 200), mock.get('headers') or {},
                body if body is not None else mock.get('body') or '')
        return True
    return False


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
    _set_flow_context(flow, run, child.get('stepKey'), child)
    verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
    _guard_replay(verdict, child, run_id, child.get('stepKey'))
    _tag_changed_pause(verdict, run_id, child.get('stepKey'))
    info = {'runId': run_id, 'stepKey': child.get('stepKey'), 'attribution': result.kind,
            'choice': child.get('mode'), 'ruleIds': _rule_applications(flow, rulesets)}
    differs = _request_differs(flow, child, runs, run)
    if differs is not None:
        info['requestChanged'] = differs
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
        _set_flow_context(flow, run, child.get('stepKey'), child)
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
        runs.ensure_known({header_run_id})
        run = runs.get(header_run_id)
        if run is not None:
            return await _apply_matched_step(flow, service_name, engine, run, header_step_key, 'HEADER', runs)

    guided = [r for r in runs.active_runs().values()
              if (r.get('driver') or '').upper() == 'GUIDED' and service_name in (r.get('projects') or [])]
    if len(guided) == 1:
        step_key = guided_step_for(flow, guided[0], runs)
        return await _apply_matched_step(flow, service_name, engine, guided[0], step_key, 'GUIDED', runs)

    return None, None


# A Guided step performed twice this quickly (double-click, page refresh) is a repeat of the same
# step, not the next step with the same endpoint.
GUIDED_REPEAT_SECONDS = 5.0


def _inbound_endpoint_matches(step, request):
    recorded = step.get('recordedRequest') if isinstance(step.get('recordedRequest'), dict) else None
    if not recorded or not recorded.get('path'):
        return False
    if (recorded.get('method') or '').upper() != (getattr(request, 'method', '') or '').upper():
        return False
    # The browser calls the app through ALFRED's own listener, so only the path is comparable.
    return _path_only(recorded.get('path')) == _path_only(getattr(request, 'path', ''))


def _path_only(path):
    path = (path or '').partition('?')[0] or '/'
    return path if path.startswith('/') else '/' + path


def guided_step_for(flow, run, runs):
    """The top-level step an untagged inbound call of a Guided run performs (FR-030b).

    The next enabled step after the last one matched, by method + path. A call matching the last
    matched step again within GUIDED_REPEAT_SECONDS is that step repeated. Skipped steps are the
    frontend's to mark. None when nothing matches: the call is the run's, but unexpected.
    """
    tops = [s for s in (run.get('steps') or []) if isinstance(s, dict) and s.get('enabled') is not False]
    run_id = run.get('runId')
    cursor = runs._guided.get(run_id)
    now = time.monotonic()
    request = flow.request
    if cursor is not None:
        last_index, last_key, at = cursor
        if now - at <= GUIDED_REPEAT_SECONDS and last_index < len(tops) \
                and tops[last_index].get('stepKey') == last_key and _inbound_endpoint_matches(tops[last_index], request):
            runs._guided[run_id] = (last_index, last_key, now)
            return last_key
    start = 0 if cursor is None else cursor[0] + 1
    for index in range(start, len(tops)):
        if _inbound_endpoint_matches(tops[index], request):
            runs._guided[run_id] = (index, tops[index].get('stepKey'), now)
            return tops[index].get('stepKey')
    return None


async def _apply_matched_step(flow, service_name, engine, run, step_key, attribution, runs):
    run_id = run.get('runId')
    if _is_stopping(run):
        return _blocked_verdict(502, {'error': 'Blocked by ALFRED Relive - run stopping', 'runId': run_id}), \
            {'runId': run_id, 'stepKey': step_key, 'attribution': attribution, 'choice': 'STOPPING'}

    step = _find_step(run, step_key, runs) if step_key else None
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
    _set_flow_context(flow, run, step.get('stepKey'), step)
    verdict = await engine.apply_request(flow, service_name, extra_rulesets=rulesets)
    _tag_changed_pause(verdict, run_id, step.get('stepKey'))
    info = {'runId': run_id, 'stepKey': step.get('stepKey'), 'attribution': attribution,
            'choice': step.get('mode'), 'ruleIds': _rule_applications(flow, rulesets)}
    return verdict, info
