"""
Traffic interception / fault injection engine, shared by BOTH mitmproxy addons.

This is the one piece of proxy code that is genuinely shared between log_and_route.py (outbound)
and log_and_route_reverse.py (inbound), rather than mirrored per direction the way the webhook
payload building is. The reason is that a rule is not direction-specific: `source` is a MATCHER
here, not a separate implementation, so an engine per addon would be two copies of the same
matching and mutation logic that must agree byte-for-byte or a rule means two different things
depending on which way the traffic was going.

Nothing in here talks to the network except the breakpoint path (see BreakpointClient, which the
addons own). Rules are read from a JSON snapshot the backend writes - the same
cache-validated-by-mtime idiom log_and_route_reverse.py's _ToggleState already uses for the
per-project logging flag, and for the same reasons: no request ever costs a database query or a
backend round trip, rules keep working while the backend is down or restarting, and a change is
picked up on the very next request without restarting this container.

THE ONE RULE THAT MUST NOT BE BROKEN: nothing in here may block. mitmproxy runs one asyncio event
loop for every connection it is proxying, so a time.sleep() to implement DELAY_REQUEST would
freeze every unrelated call in flight for the duration. Delays are returned to the caller as a
number and awaited with asyncio.sleep() in an async hook; see apply_request's return value and
the addons' `async def request`.

With no rules file, an empty rules list, or `enabled: false`, every entry point returns an
inert verdict after one dict lookup, and the addons behave exactly as they did before this
module existed.
"""

import json
import os
import re
import time
from http import HTTPStatus

# Written by the backend's FileRulesPublisherAdapter, bind-mounted into both proxy containers -
# see docker-compose.yml. Absent is the normal state for a deployment that has never created a
# rule, and must stay indistinguishable from "no rules".
RULES_FILE = os.environ.get('INTERCEPTION_RULES_FILE', '/home/mitmproxy/interception-rules.json')

# A delay is the one action that can hold a connection open for an unbounded time by accident -
# a typo of 600000 instead of 6000 is ten minutes of a held socket. Rules are validated
# backend-side too, but this is the last line of defence and it lives where the sleep happens.
MAX_DELAY_MS = int(os.environ.get('INTERCEPTION_MAX_DELAY_MS', '120000'))

# How long a paused call may hold its caller open before it is released by the timeout rule.
# Backend validation caps the per-rule value against this as well.
MAX_PAUSE_SECONDS = int(os.environ.get('INTERCEPTION_MAX_PAUSE_SECONDS', '300'))

REQUEST_ACTIONS = {
    'DELAY_REQUEST', 'SET_REQUEST_HEADER', 'REMOVE_REQUEST_HEADER',
    'SET_QUERY_PARAM', 'REMOVE_QUERY_PARAM', 'SET_REQUEST_JSON_FIELD',
    'ABORT_REQUEST', 'MOCK_RESPONSE', 'PAUSE_REQUEST', 'SEND_TO_HOST',
    'SIMULATE_FAILURE', 'IF_REQUEST',
}
RESPONSE_ACTIONS = {
    'DELAY_RESPONSE', 'SET_RESPONSE_STATUS', 'SET_RESPONSE_HEADER',
    'REMOVE_RESPONSE_HEADER', 'SET_RESPONSE_JSON_FIELD', 'SET_RESPONSE_BODY',
    'REPLACE_RESPONSE', 'PAUSE_RESPONSE', 'IF_RESPONSE',
}

# An action that ends the request phase: there is no upstream request left for a later rule to
# modify, so evaluation stops rather than silently applying edits to something already gone.
TERMINAL_REQUEST_ACTIONS = {'ABORT_REQUEST', 'MOCK_RESPONSE', 'SIMULATE_FAILURE'}

# What SIMULATE_FAILURE can reproduce - the mirror of the backend's FailureMode enum, matched by
# string. Everything a supplier does that is NOT a status code.
#
# Nothing here pretends to be a DNS or TLS failure. The caller is connected to Alfred, not to the
# supplier, and its handshake with Alfred already succeeded before any rule was evaluated - the
# connection those failures would have to break is one that demonstrably works. What is reachable
# from here is a reset, a hang, or a reply that is wrong at the transport level, which is what
# these are.
FAILURE_MODES = {
    'CONNECTION_RESET', 'HANG_THEN_DROP', 'HANG_UNTIL_CALLER_GIVES_UP',
    'EMPTY_REPLY', 'TRUNCATED_BODY', 'GATEWAY_ERROR',
}

# How long "hang until the caller gives up" holds before Alfred stops waiting too. The point of
# that mode is that the CALLER's timeout fires first; this only exists so a client with no timeout
# at all cannot pin a connection open forever.
MAX_HANG_SECONDS = int(os.environ.get('INTERCEPTION_MAX_HANG_SECONDS', str(MAX_PAUSE_SECONDS)))

# Header names whose VALUE is never written into an interception record. The record says a header
# was set and names it; the value would end up in the call log, in every export, and in the
# Flagged Issues section that echoes stored text verbatim - the same constraint
# redaction.model.ts states for redactions, for the same reason.
SENSITIVE_HEADERS = {
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-api-key', 'api-key', 'x-auth-token', 'authentication',
}


def _sensitive(name):
    return (name or '').strip().lower() in SENSITIVE_HEADERS


def _snapshot(message, include_target=False):
    """One half of an exchange, frozen.

    `include_target` adds method and url, which only make sense for a request - and matter,
    because a rule that rewrites a query parameter changes the url and nothing else, so a
    snapshot without it would show two identical copies.
    """
    try:
        body = message.get_text(strict=False)
    except Exception:
        body = None
    snapshot = {'headers': dict(message.headers), 'body': body}
    status = getattr(message, 'status_code', None)
    if status is not None:
        snapshot['status'] = status
        # mitmproxy keeps the upstream's reason; carried so a status diff can show
        # "200 OK -> 500 Internal Server Error" rather than two bare numbers.
        reason = getattr(message, 'reason', None)
        if reason:
            snapshot['reason'] = reason
    if include_target:
        snapshot['method'] = getattr(message, 'method', None)
        snapshot['url'] = getattr(message, 'pretty_url', None)
    return snapshot


class Match:
    """One rule's matching conditions. Every field is optional; an absent field matches anything,
    so a rule with an empty match applies to all traffic (which is why the UI states the match
    back to the user in plain language before saving)."""

    __slots__ = ('source', 'service_names', 'methods', 'host', 'path_contains', 'path_regex')

    def __init__(self, raw):
        raw = raw or {}
        source = (raw.get('source') or 'both').strip().lower()
        self.source = source if source in ('outbound', 'inbound') else None
        # `serviceName` is the pre-list shape. Still read, because the rules file on disk can be
        # older than this container - a deployment that updates the proxy before the backend
        # republishes must not silently widen every project-scoped rule to all traffic.
        names = raw.get('serviceNames')
        if not names:
            legacy = (raw.get('serviceName') or '').strip()
            names = [legacy] if legacy else []
        elif isinstance(names, str):
            names = [names]
        self.service_names = frozenset(str(n).strip() for n in names if str(n).strip()) or None
        methods = raw.get('methods') or []
        if isinstance(methods, str):
            methods = [methods]
        self.methods = {str(m).strip().upper() for m in methods if str(m).strip()} or None
        self.host = (raw.get('host') or '').strip().lower() or None
        self.path_contains = (raw.get('pathContains') or '').strip() or None
        # Compiled ONCE, here, at rule-load time. Compiling per request would put a regex
        # compilation on the hot path of every proxied call for every rule that has one.
        pattern = (raw.get('pathRegex') or '').strip()
        self.path_regex = re.compile(pattern) if pattern else None

    def matches(self, source, service_name, method, host, path):
        # Ordered cheapest first: a rule that doesn't apply to this direction costs one string
        # comparison, not a regex.
        if self.source is not None and self.source != source:
            return False
        if self.service_names is not None and service_name not in self.service_names:
            return False
        if self.methods is not None and (method or '').upper() not in self.methods:
            return False
        if self.host is not None and not _host_matches(self.host, host):
            return False
        if self.path_contains is not None and self.path_contains not in (path or ''):
            return False
        if self.path_regex is not None and not self.path_regex.search(path or ''):
            return False
        return True


def _host_matches(pattern, host):
    """Exact, or a leading `*.` suffix match. Deliberately not a general glob: `*.sabre.com` is
    the only wildcard shape anyone has needed, and a full glob invites patterns whose behaviour
    is hard to predict from reading the rule list."""
    host = (host or '').lower()
    if not host:
        return False
    if pattern.startswith('*.'):
        suffix = pattern[1:]  # ".sabre.com"
        return host.endswith(suffix) or host == pattern[2:]
    return host == pattern


class Rule:
    __slots__ = ('id', 'name', 'enabled', 'priority', 'stop_processing', 'match', 'actions')

    def __init__(self, raw):
        self.id = str(raw.get('id') or '')
        self.name = raw.get('name') or '(unnamed rule)'
        self.enabled = raw.get('enabled', True) is not False
        try:
            self.priority = int(raw.get('priority', 100))
        except (TypeError, ValueError):
            self.priority = 100
        self.stop_processing = raw.get('stopProcessing', False) is True
        self.match = Match(raw.get('match'))
        self.actions = _prepare_actions(raw.get('actions'))


def _prepare_actions(raw_actions):
    """Keeps actions as the plain dicts the engine reads, with one addition: a conditional gets its
    branches parsed into Branch objects under a private key.

    Done at LOAD time, once, because that is when a regex can be compiled and a malformed branch
    can be dropped - doing either per request would put the cost on every call the rule matches.
    The private key is stored on the dict we parsed rather than in a side table keyed by identity,
    which would be fragile for no benefit; nothing ever re-serialises these dicts.
    """
    prepared = []
    for action in (raw_actions or []):
        if not isinstance(action, dict) or not action.get('type'):
            continue
        if action['type'] in ('IF_REQUEST', 'IF_RESPONSE'):
            action['__branches'] = [Branch(b) for b in (action.get('branches') or []) if isinstance(b, dict)]
            action['__otherwise'] = _prepare_actions(action.get('otherwise'))
        prepared.append(action)
    return prepared


class RuleSet:
    """The parsed snapshot. `enabled` is the master switch - one flag that turns the whole feature
    off without touching a single rule, which is what the UI's "Turn all off" writes."""

    __slots__ = ('enabled', 'rules', 'error')

    def __init__(self, enabled=False, rules=None, error=None):
        self.enabled = enabled
        self.rules = rules or []
        self.error = error

    @property
    def inert(self):
        return not self.enabled or not self.rules


EMPTY_RULESET = RuleSet()


class _RulesCache:
    """Re-reads RULES_FILE only when its mtime changes - identical idiom to
    log_and_route_reverse.py's _ToggleState. A missing file is the normal state for a deployment
    with no rules and must cost nothing and log nothing."""

    def __init__(self, path=None):
        self._path = path or RULES_FILE
        self._mtime = None
        self._ruleset = EMPTY_RULESET

    def current(self):
        try:
            mtime = os.path.getmtime(self._path)
        except OSError:
            # No file at all: the feature has never been used here. Reset so that deleting the
            # file really does disable everything, rather than leaving the last load resident.
            if self._mtime is not None:
                self._mtime = None
                self._ruleset = EMPTY_RULESET
            return self._ruleset
        if mtime != self._mtime:
            self._mtime = mtime
            self._ruleset = self._load()
        return self._ruleset

    def _load(self):
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                raw = json.load(f)
        except (OSError, ValueError) as e:
            # A half-written or corrupt file must not take traffic down with it. Keeping the
            # PREVIOUS ruleset would be worse: the file is the only statement of intent, and
            # silently running rules the user may have just deleted is the wrong failure.
            print(f"[interception] could not read {self._path}, interception disabled: {e}")
            return RuleSet(error=str(e))

        if not isinstance(raw, dict):
            return RuleSet(error='rules file is not an object')

        enabled = raw.get('enabled', False) is True
        rules = []
        for entry in (raw.get('rules') or []):
            if not isinstance(entry, dict):
                continue
            try:
                rule = Rule(entry)
            except re.error as e:
                # One bad regex disables ONE rule, never the file. The backend validates regexes
                # before writing, so reaching here means the file was hand-edited.
                print(f"[interception] skipping rule {entry.get('name')!r}: bad pathRegex: {e}")
                continue
            if rule.enabled and rule.actions:
                rules.append(rule)

        # Ascending priority, then the file's own order for ties - the backend writes rules in
        # its stored order, so a tie is resolved the same way the UI lists them.
        rules.sort(key=lambda r: r.priority)
        return RuleSet(enabled=enabled, rules=rules)


# ---------------------------------------------------------------------------------------------
# Conditions: "look at the call, then decide".
#
# Mirrors the backend's ConditionSubject / ConditionOperator enums, matched by string. A condition
# is evaluated against the live flow; what it can look at depends on the phase, and the engine
# never guesses - a response subject read during the request phase has no value, which the
# operators below treat as absent rather than as an error.
# ---------------------------------------------------------------------------------------------

SUBJECTS = {
    'REQUEST_HEADER', 'REQUEST_BODY', 'REQUEST_JSON_FIELD', 'QUERY_PARAM', 'URL', 'METHOD',
    'RESPONSE_STATUS', 'RESPONSE_HEADER', 'RESPONSE_BODY', 'RESPONSE_JSON_FIELD',
}

OPERATORS = {
    'EXISTS', 'NOT_EXISTS', 'EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS',
    'MATCHES', 'NOT_MATCHES', 'AT_LEAST', 'AT_MOST',
}

# Operators whose answer when the subject is ABSENT is True. An absent subject is never equal to,
# does not contain and does not match anything - so the negative of each of those is satisfied.
# Stated as data rather than buried in an if, because this is the one semantic here that surprises
# people and it must read the same in both languages.
TRUE_WHEN_ABSENT = {'NOT_EXISTS', 'NOT_EQUALS', 'NOT_CONTAINS', 'NOT_MATCHES'}


def get_json_field(text, path):
    """Every value at `path` inside a JSON document, as a list.

    A list rather than one value because `[*]` is part of the supported path syntax: with a
    wildcard the honest answer is "these values", and collapsing it to the first would make
    `segments[*].cabin equals J` quietly mean "the first segment's cabin", which is not what it
    says. An unreadable body or a path that is not there yields an empty list - absent, not an
    error, so a condition on a field a supplier sometimes omits stays usable.
    """
    if not text:
        return []
    try:
        doc = json.loads(text)
    except ValueError:
        return []
    return _collect(doc, _parse_path(path))


def _collect(node, segments):
    if not segments:
        return [node]
    head, rest = segments[0], segments[1:]
    if head == '*':
        if not isinstance(node, list):
            return []
        out = []
        for item in node:
            out.extend(_collect(item, rest))
        return out
    if isinstance(head, int):
        if not isinstance(node, list) or head >= len(node) or head < -len(node):
            return []
        return _collect(node[head], rest)
    if not isinstance(node, dict) or head not in node:
        return []
    return _collect(node[head], rest)


def _header(message, name):
    """Case-insensitively, as HTTP header names are - mitmproxy's Headers already does this."""
    if message is None:
        return None
    try:
        return message.headers.get(name)
    except Exception:
        return None


def _as_text(value):
    return None if value is None else (value if isinstance(value, str) else json.dumps(value))


class Condition:
    """One test, with its regex compiled ONCE at rule-load time.

    Compiling per request would put a regex compilation on the hot path of every call a rule
    matches, for every condition it has - the same reason Match compiles pathRegex at load.
    """

    __slots__ = ('subject', 'name', 'operator', 'value', 'case_sensitive', 'pattern', 'number')

    def __init__(self, raw):
        raw = raw or {}
        self.subject = (raw.get('subject') or '').strip().upper()
        self.name = raw.get('name')
        self.operator = (raw.get('operator') or '').strip().upper()
        value = raw.get('value')
        self.value = None if value is None else str(value)
        self.case_sensitive = raw.get('caseSensitive') is True

        self.pattern = None
        if self.operator in ('MATCHES', 'NOT_MATCHES') and self.value is not None:
            flags = 0 if self.case_sensitive else re.IGNORECASE
            self.pattern = re.compile(self.value, flags)

        self.number = None
        if self.operator in ('AT_LEAST', 'AT_MOST') and self.value is not None:
            try:
                self.number = float(self.value)
            except ValueError:
                self.number = None

    @property
    def valid(self):
        return self.subject in SUBJECTS and self.operator in OPERATORS

    def values(self, flow):
        """Everything this subject resolves to - empty means absent."""
        request = flow.request
        response = getattr(flow, 'response', None)

        if self.subject == 'REQUEST_HEADER':
            return _one(_header(request, self.name))
        if self.subject == 'RESPONSE_HEADER':
            return _one(_header(response, self.name))
        if self.subject == 'REQUEST_BODY':
            return _one(_body(request))
        if self.subject == 'RESPONSE_BODY':
            return _one(_body(response))
        if self.subject == 'REQUEST_JSON_FIELD':
            return [_as_text(v) for v in get_json_field(_body(request), self.name)]
        if self.subject == 'RESPONSE_JSON_FIELD':
            return [_as_text(v) for v in get_json_field(_body(response), self.name)]
        if self.subject == 'QUERY_PARAM':
            try:
                return _one(request.query.get(self.name))
            except Exception:
                return []
        if self.subject == 'URL':
            return _one(getattr(request, 'pretty_url', None))
        if self.subject == 'METHOD':
            return _one(getattr(request, 'method', None))
        if self.subject == 'RESPONSE_STATUS':
            status = getattr(response, 'status_code', None)
            return _one(None if status is None else str(status))
        return []

    def holds(self, flow):
        if not self.valid:
            # A condition the engine does not understand must not silently pass: a branch that
            # runs because a typo was ignored is worse than one that never runs.
            return False

        values = [v for v in self.values(flow) if v is not None]

        if self.operator == 'EXISTS':
            return bool(values)
        if self.operator == 'NOT_EXISTS':
            return not values
        if not values:
            return self.operator in TRUE_WHEN_ABSENT

        # With `[*]` a subject can resolve to several values. A positive operator holds if ANY of
        # them satisfies it, and its negative holds only if NONE does - so `NOT_CONTAINS` really
        # means "no element contains this", which is the only reading under which a condition and
        # its negation cannot both be true.
        negative = self.operator.startswith('NOT_')
        any_match = any(self._one_holds(value) for value in values)
        return not any_match if negative else any_match

    def _one_holds(self, value):
        """Whether ONE resolved value satisfies the positive form of this operator."""
        if self.operator in ('MATCHES', 'NOT_MATCHES'):
            return self.pattern is not None and self.pattern.search(value) is not None
        if self.operator in ('AT_LEAST', 'AT_MOST'):
            if self.number is None:
                return False
            try:
                number = float(value)
            except (TypeError, ValueError):
                # Not a number is not "smaller than" anything - it simply does not satisfy a
                # numeric test, in either direction.
                return False
            return number >= self.number if self.operator == 'AT_LEAST' else number <= self.number

        left, right = value, self.value or ''
        if not self.case_sensitive:
            left, right = left.lower(), right.lower()
        if self.operator in ('EQUALS', 'NOT_EQUALS'):
            return left == right
        return right in left  # CONTAINS / NOT_CONTAINS

    def describe(self):
        """For the call log. Names what was tested, and never the value of a secret."""
        subject = self.subject.lower().replace('_', ' ')
        if self.name:
            subject = f'{subject} {self.name}'
        operator = self.operator.lower().replace('_', ' ')
        if self.operator in ('EXISTS', 'NOT_EXISTS'):
            return f'{subject} {operator}'
        if _sensitive(self.name):
            return f'{subject} {operator} (value not logged)'
        return f'{subject} {operator} {self.value}'


def _one(value):
    return [] if value is None else [value]


def _body(message):
    if message is None:
        return None
    try:
        return message.get_text(strict=False)
    except Exception:
        return None


class Branch:
    """One arm of a conditional: conditions, and the actions to run when they hold."""

    __slots__ = ('combine_any', 'conditions', 'actions')

    def __init__(self, raw):
        raw = raw or {}
        self.combine_any = (raw.get('combine') or 'ALL').strip().upper() == 'ANY'
        self.conditions = [Condition(c) for c in (raw.get('conditions') or []) if isinstance(c, dict)]
        self.actions = _prepare_actions(raw.get('actions'))

    def holds(self, flow):
        if not self.conditions:
            # A branch with no conditions would always match and swallow everything below it. The
            # backend rejects one; a hand-edited file should not get a free "always".
            return False
        if self.combine_any:
            return any(c.holds(flow) for c in self.conditions)
        return all(c.holds(flow) for c in self.conditions)

    def describe(self):
        joiner = ' or ' if self.combine_any else ' and '
        return joiner.join(c.describe() for c in self.conditions)


class Applied:
    """One action's effect, as recorded for the call log. Never carries a secret - see
    SENSITIVE_HEADERS."""

    __slots__ = ('rule_id', 'rule_name', 'action', 'detail')

    def __init__(self, rule_id, rule_name, action, detail=None):
        self.rule_id = rule_id
        self.rule_name = rule_name
        self.action = action
        self.detail = detail

    def as_dict(self):
        out = {'ruleId': self.rule_id, 'ruleName': self.rule_name, 'action': self.action}
        if self.detail:
            out['detail'] = self.detail
        return out


class Verdict:
    """What the addon must do after the engine has finished with a flow.

    Mutations that are cheap and synchronous (headers, query, body) have ALREADY been applied to
    the flow by the time this is returned. Everything that needs the event loop - sleeping,
    waiting on a human - is described here and carried out by the addon's async hook.
    """

    __slots__ = ('delay_ms', 'terminal', 'mock', 'failure', 'pause', 'applied', 'must_reach_host',
                 'pre_request', 'pre_response', 'synthetic_response',
                 'original_request', 'original_response', 'final_request', 'final_response')

    def __init__(self):
        self.delay_ms = 0
        self.terminal = None      # 'ABORT_REQUEST' | 'MOCK_RESPONSE' | 'SIMULATE_FAILURE' | None
        self.mock = None          # {'status':int,'headers':dict,'body':str}
        self.failure = None       # {'mode':str,'durationMs':int,'status':int|None,'body':str|None}
        self.pause = None         # {'phase':'request'|'response','timeoutSeconds':int,'onTimeout':str,'ruleId','ruleName'}
        self.applied = []
        # Working snapshots: each half as it stood the moment a rule first matched, before any
        # action ran. Taken by observe_*, compared by finalize_*. Not reported anywhere - they
        # become original_*/final_* only if the two ends actually differ.
        self.pre_request = None
        self.pre_response = None
        # A response that exists without an upstream one ever having been seen - mocked, and
        # therefore one-sided: there is no "before" to diff against, only an "instead of".
        self.synthetic_response = False
        # What each half looked like BEFORE anything touched it, and after everything had. Both
        # are set together or not at all, by finalize_*. None means that half came out the way it
        # went in, which is the overwhelmingly common case.
        self.original_request = None
        self.original_response = None
        self.final_request = None
        self.final_response = None
        # Set by SEND_TO_HOST. Once true, no later rule may short-circuit this call - see
        # _apply_request_action. This is what makes "always really call this endpoint" expressible
        # as a narrow, high-priority exception to a broad mocking rule.
        self.must_reach_host = False

    @property
    def touched(self):
        return bool(self.applied)

    def record(self, rule, action, detail=None):
        self.applied.append(Applied(rule.id, rule.name, action, detail))

    def observe_request(self, flow):
        """Freezes the request the moment a rule matches, before any action has run.

        Deliberately NOT called from inside an action. An earlier design had each mutating action
        announce "I am about to change this" - which worked, and which meant every future action
        had to remember to say so, with a silently missing before/after as the penalty for
        forgetting. Snapshotting on both sides of the whole phase and comparing them instead makes
        the record a property of what actually happened to the flow, so an action added later is
        covered by construction rather than by diligence.

        Once per phase: a second match must not overwrite the first snapshot with a half-modified
        one.
        """
        if self.pre_request is None:
            self.pre_request = _snapshot(flow.request, include_target=True)

    def observe_response(self, flow):
        if self.pre_response is None and flow.response is not None:
            self.pre_response = _snapshot(flow.response)

    def adopt(self, other):
        """Folds a response-phase verdict into the one carried on the flow.

        The response phase builds its own Verdict because it has its own delay and its own pause,
        but the RECORD is one record per call. Copying only `applied` across - which is what this
        used to do - threw away every response-phase snapshot on the floor, so no response action
        has ever produced a before/after. Merging state rather than one chosen field is the fix
        that stays fixed.
        """
        self.applied.extend(other.applied)
        if self.pre_response is None:
            self.pre_response = other.pre_response

    def finalize_request(self, flow):
        """Compares the request against its pre-action snapshot, once nothing further will touch it.

        The call log cannot serve as the "after" side on its own. The request half is written to
        the log at PREPARE time - before the request is forwarded, and therefore before a request
        breakpoint has let anyone edit it - so a hand-edited request would be recorded exactly as
        it arrived, and the diff would show no change while the log insisted one had been made.
        Keeping both ends here makes the record self-contained and independent of when the log was
        written.
        """
        if self.pre_request is not None:
            after = _snapshot(flow.request, include_target=True)
            # Nothing recorded when nothing moved: a rule that only delayed the call, or set a
            # header to the value it already had, leaves the log the size it was.
            if after != self.pre_request:
                self.original_request = self.pre_request
                self.final_request = after

        # A response that exists at the END of the request phase was manufactured here - upstream
        # was never contacted. Stated as a structural fact about the flow rather than by testing
        # for MOCK_RESPONSE, so anything else that answers early is reported the same way.
        if self.pre_response is None and flow.response is not None:
            self.synthetic_response = True
            self.final_response = _snapshot(flow.response)

    def finalize_response(self, flow):
        if flow.response is None:
            return
        after = _snapshot(flow.response)
        if self.synthetic_response:
            # There is no upstream answer to diff against, so original_response stays absent and
            # the reader is told the whole thing is Alfred's. Keeping the final side current still
            # matters: a response rule may have edited the mock after it was made.
            self.final_response = after
            return
        if self.pre_response is not None and after != self.pre_response:
            self.original_response = self.pre_response
            self.final_response = after

    def as_log(self):
        """The `interception` object that rides on the existing two-phase webhook. Returns None
        when nothing happened, so an untouched call's payload is byte-identical to before."""
        if not self.applied:
            return None
        out = {'applied': [a.as_dict() for a in self.applied]}
        # Both halves as they were before anything touched them. Present only when that half was
        # actually modified, so the reader can tell "unchanged" from "not recorded" - and so an
        # export never doubles in size for a call that was only delayed.
        if self.original_request is not None:
            out['originalRequest'] = self.original_request
        if self.original_response is not None:
            out['originalResponse'] = self.original_response
        if self.final_request is not None:
            out['finalRequest'] = self.final_request
        if self.final_response is not None:
            out['finalResponse'] = self.final_response
        return out


# What each failure mode is recorded as in the call log. Plain English rather than the constant,
# because this is read on a call card by somebody working out why a booking failed.
FAILURE_DETAIL = {
    'CONNECTION_RESET': 'connection reset, upstream never contacted',
    'HANG_THEN_DROP': 'held, then the connection was dropped',
    'HANG_UNTIL_CALLER_GIVES_UP': 'held until the caller gave up',
    'EMPTY_REPLY': 'empty reply, upstream never contacted',
    'TRUNCATED_BODY': 'body cut short of its declared length',
    'GATEWAY_ERROR': 'gateway failure, upstream never contacted',
}

# Body a gateway failure replies with when the rule does not supply one. Shaped like something an
# intermediary would actually send, so a client's error handling sees a realistic payload.
DEFAULT_GATEWAY_BODY = '{"error":"Bad Gateway","message":"The upstream service could not be reached."}'


def failure_plan(failure):
    """Turns a failure verdict into what the addon must physically do.

    Returned as a plan rather than carried out here because this module deliberately imports
    nothing from mitmproxy - building a Response needs `mitmproxy.http`, and the engine's tests
    run without mitmproxy installed. The addons own the two lines that touch it; the decision of
    WHICH failure means what lives here, once, for both directions.

    Shape:
        {'sleep': seconds or 0,
         'kill': bool,
         'response': {'status', 'body', 'headers', 'declaredLength'} or None}

    `declaredLength` is the Content-Length to claim regardless of what is actually sent - the one
    thing that makes a truncated reply a truncated reply.
    """
    mode = (failure or {}).get('mode')

    if mode == 'CONNECTION_RESET':
        return {'sleep': 0, 'kill': True, 'response': None}

    if mode == 'HANG_THEN_DROP':
        return {'sleep': min(failure.get('durationMs') or 0, MAX_DELAY_MS) / 1000.0,
                'kill': True, 'response': None}

    if mode == 'HANG_UNTIL_CALLER_GIVES_UP':
        # Alfred never ends this one on purpose; the cap only stops a client with no timeout of
        # its own from pinning the connection open indefinitely.
        return {'sleep': MAX_HANG_SECONDS, 'kill': True, 'response': None}

    if mode == 'EMPTY_REPLY':
        return {'sleep': 0, 'kill': False,
                'response': {'status': 200, 'body': '', 'headers': {}, 'declaredLength': None}}

    if mode == 'TRUNCATED_BODY':
        body = failure.get('body') or ''
        # Half, rounded down, and at least one byte of a non-empty body - the point is that some
        # of it arrives and then stops, which is what a client library reports differently from an
        # empty reply. Connection: close because a promise of more bytes on a keep-alive socket
        # would just stall the next request on it.
        sent = body[:max(1, len(body) // 2)] if body else ''
        return {'sleep': 0, 'kill': False, 'response': {
            'status': 200,
            'body': sent,
            'headers': {'content-type': 'application/json', 'connection': 'close'},
            'declaredLength': len(body.encode('utf-8')),
        }}

    if mode == 'GATEWAY_ERROR':
        status = failure.get('status')
        status = status if status in (502, 503, 504) else 502
        body = failure.get('body')
        return {'sleep': 0, 'kill': False, 'response': {
            'status': status,
            'body': DEFAULT_GATEWAY_BODY if body is None else str(body),
            'headers': {'content-type': 'application/json'},
            'declaredLength': None,
        }}

    # Unknown modes are filtered at the action, so reaching here means the verdict was built by
    # hand. Do nothing rather than guess - a wrong guess kills a live call.
    return {'sleep': 0, 'kill': False, 'response': None}


def set_status(response, status):
    """Sets a response's status AND its reason phrase.

    mitmproxy keeps whatever reason the upstream sent, so changing only status_code produces
    replies like "503 Temporary Redirect" - the number says one thing and the text beside it says
    another, in a tool whose whole job is telling you what actually happened. Any status outside
    the well-known set keeps an empty phrase rather than a wrong one.
    """
    try:
        status = int(status)
    except (TypeError, ValueError):
        return False
    if not 100 <= status <= 599:
        return False
    response.status_code = status
    try:
        response.reason = HTTPStatus(status).phrase
    except (ValueError, AttributeError):
        try:
            response.reason = ''
        except AttributeError:
            pass
    return True


def _clamp_delay(value):
    try:
        ms = int(value)
    except (TypeError, ValueError):
        return 0
    if ms <= 0:
        return 0
    return min(ms, MAX_DELAY_MS)


def set_json_field(text, path, value):
    """Sets `path` inside a JSON document, returning the new text, or None if nothing changed.

    Returning None rather than the original text is deliberate: an unchanged body must be left
    byte-identical rather than re-serialised, so a 5.9MB payload that no rule actually matched is
    neither reformatted nor reindented (the same rule redact.ts follows).

    Path syntax is a deliberate SUBSET of JSONPath - dotted segments, `[0]` indexes and `[*]` for
    every element of an array. Full JSONPath would mean a dependency, and the proxy runs a stock
    mitmproxy image with bind-mounted scripts and no pip step; owning a custom image for this is
    a bigger decision than the feature needs. Everything real traffic has needed is expressible:
    `currency`, `itinerary.seatsRemaining`, `segments[*].cabin`.
    """
    if not text:
        return None
    try:
        doc = json.loads(text)
    except ValueError:
        return None
    if not _assign(doc, _parse_path(path), value):
        return None
    return json.dumps(doc)


def _parse_path(path):
    """'a.b[0].c' / 'a[*].c' -> ['a', 'b', 0, 'c'] / ['a', '*', 'c']"""
    segments = []
    for part in str(path or '').split('.'):
        if not part:
            continue
        name, _, rest = part.partition('[')
        if name:
            segments.append(name)
        while rest:
            index, _, rest = rest.partition(']')
            index = index.strip()
            if index == '*':
                segments.append('*')
            elif index.lstrip('-').isdigit():
                segments.append(int(index))
            rest = rest.lstrip('[')
    return segments


def _assign(node, segments, value):
    """Walks to the parent of the target and sets it. Returns whether anything was actually set,
    so a path that doesn't exist in this particular body is reported as "no change" rather than
    silently creating a field the supplier never sends."""
    if not segments:
        return False
    head, rest = segments[0], segments[1:]

    if head == '*':
        if not isinstance(node, list):
            return False
        # Every element, not the first one that succeeds: `any()` over a generator short-circuits,
        # which made `segments[*].cabin` silently rewrite only segment 0 and leave the rest alone.
        # Collect first, then reduce.
        results = [_assign(item, rest, value) if rest else _set_item(node, i, value)
                   for i, item in enumerate(list(node))]
        return any(results)

    if isinstance(head, int):
        if not isinstance(node, list) or head >= len(node) or head < -len(node):
            return False
        if not rest:
            node[head] = value
            return True
        return _assign(node[head], rest, value)

    if not isinstance(node, dict) or head not in node:
        return False
    if not rest:
        node[head] = value
        return True
    return _assign(node[head], rest, value)


def _set_item(node, index, value):
    node[index] = value
    return True


class InterceptionEngine:
    """Stateless apart from the rules cache - one instance per addon process."""

    def __init__(self, source, rules_file=None):
        # 'outbound' for log_and_route.py, 'inbound' for log_and_route_reverse.py. Fixed per
        # process, since a given mitmproxy addon only ever sees one direction.
        self.source = source
        self._cache = _RulesCache(rules_file)

    def enabled(self):
        return not self._cache.current().inert

    def _matching(self, flow, service_name):
        ruleset = self._cache.current()
        if ruleset.inert:
            return ()
        request = flow.request
        host = (request.pretty_host or request.host or '')
        path = request.path or ''
        out = []
        for rule in ruleset.rules:
            try:
                if rule.match.matches(self.source, service_name, request.method, host, path):
                    out.append(rule)
                    if rule.stop_processing:
                        break
            except Exception as e:
                # A rule that throws is skipped, never fatal - proxying must survive a bad rule.
                print(f"[interception] rule {rule.name!r} failed to match, skipping: {e}")
        return out

    def apply_request(self, flow, service_name=None):
        """Applies every matching rule's request-phase actions, mutating the flow in place for
        everything synchronous. Returns a Verdict describing what the addon still has to do."""
        verdict = Verdict()
        matching = self._matching(flow, service_name)
        if matching:
            # Once, up front, for the whole phase - see Verdict.observe_request. A call no rule
            # matches never reaches this line and so never pays for a snapshot.
            verdict.observe_request(flow)
        for rule in matching:
            for action in rule.actions:
                kind = action.get('type')
                if kind not in REQUEST_ACTIONS:
                    continue
                try:
                    self._apply_request_action(flow, rule, action, kind, verdict)
                except Exception as e:
                    print(f"[interception] rule {rule.name!r} action {kind} failed, skipping: {e}")
                    continue
                if verdict.terminal:
                    return verdict
                if verdict.pause and verdict.pause['phase'] == 'request':
                    return verdict
        return verdict

    def _apply_request_action(self, flow, rule, action, kind, verdict):
        request = flow.request

        if kind == 'IF_REQUEST':
            self._run_conditional(flow, rule, action, kind, verdict, REQUEST_ACTIONS,
                                  self._apply_request_action)
            return

        if kind == 'DELAY_REQUEST':
            ms = _clamp_delay(action.get('durationMs'))
            if ms:
                # Delays SUM across rules rather than the last one winning: "both should
                # execute" is the stated model, and a rule silently cancelling an earlier
                # rule's delay is the surprising reading. The total is clamped by the addon.
                verdict.delay_ms += ms
                verdict.record(rule, kind, f'{ms} ms')
            return

        if kind == 'SET_REQUEST_HEADER':
            name = (action.get('name') or '').strip()
            if name:
                request.headers[name] = str(action.get('value', ''))
                verdict.record(rule, kind, name if not _sensitive(name) else f'{name} (value not logged)')
            return

        if kind == 'REMOVE_REQUEST_HEADER':
            name = (action.get('name') or '').strip()
            if name and name in request.headers:
                del request.headers[name]
                verdict.record(rule, kind, name)
            return

        if kind == 'SET_QUERY_PARAM':
            name = (action.get('name') or '').strip()
            if name:
                request.query[name] = str(action.get('value', ''))
                verdict.record(rule, kind, f'{name}={action.get("value", "")}')
            return

        if kind == 'REMOVE_QUERY_PARAM':
            name = (action.get('name') or '').strip()
            if name and name in request.query:
                del request.query[name]
                verdict.record(rule, kind, name)
            return

        if kind == 'SET_REQUEST_JSON_FIELD':
            # .text, never .content: mitmproxy decodes content-encoding for us here, and a
            # gzipped body read as bytes would be corrupted by a naive rewrite.
            updated = set_json_field(request.text, action.get('path'), action.get('value'))
            if updated is not None:
                request.text = updated
                verdict.record(rule, kind, str(action.get('path')))
            return

        if kind == 'SEND_TO_HOST':
            # "Actually call the real thing, whatever anything else says."
            #
            # Forwarding is already what happens by default, so on its own this is a statement of
            # intent that makes a rule read as a pipeline - send, then handle what comes back. What
            # makes it more than documentation is the latch: once set, a MOCK_RESPONSE or
            # ABORT_REQUEST from any LATER rule is refused rather than applied. That is how a
            # narrow exception ("but always really hit /health") is expressed against a broad
            # mocking rule, without having to edit the broad rule to carve a hole in it.
            #
            # It has no effect on an earlier rule that already short-circuited: that call is
            # already decided by the time this rule is reached, which is what `priority` is for.
            verdict.must_reach_host = True
            verdict.record(rule, kind, 'forwarded to upstream')
            return

        if kind == 'ABORT_REQUEST':
            if verdict.must_reach_host:
                verdict.record(rule, kind, 'skipped - an earlier rule requires this call to reach the host')
                return
            verdict.terminal = 'ABORT_REQUEST'
            verdict.record(rule, kind, 'connection killed')
            return

        if kind == 'MOCK_RESPONSE':
            if verdict.must_reach_host:
                verdict.record(rule, kind, 'skipped - an earlier rule requires this call to reach the host')
                return
            headers = action.get('headers') or {}
            if not isinstance(headers, dict):
                headers = {}
            body = action.get('body')
            body = '' if body is None else str(body)
            status = action.get('status', 200)
            try:
                status = int(status)
            except (TypeError, ValueError):
                status = 200
            verdict.terminal = 'MOCK_RESPONSE'
            verdict.mock = {'status': status, 'headers': {str(k): str(v) for k, v in headers.items()}, 'body': body}
            verdict.record(rule, kind, f'{status}, upstream never contacted')
            return

        if kind == 'SIMULATE_FAILURE':
            if verdict.must_reach_host:
                verdict.record(rule, kind, 'skipped - an earlier rule requires this call to reach the host')
                return
            mode = (action.get('failure') or '').strip().upper()
            if mode not in FAILURE_MODES:
                # An unknown mode must not silently become "reset the connection" - killing a call
                # nobody asked to kill is the worst possible reading of a typo.
                verdict.record(rule, kind, f'skipped - unknown failure {mode or "(none)"}')
                return
            verdict.terminal = 'SIMULATE_FAILURE'
            verdict.failure = {
                'mode': mode,
                'durationMs': _clamp_delay(action.get('durationMs')),
                'status': action.get('status'),
                'body': action.get('body'),
            }
            verdict.record(rule, kind, FAILURE_DETAIL.get(mode, mode))
            return

        if kind == 'PAUSE_REQUEST':
            verdict.pause = self._pause_spec(rule, action, 'request')
            verdict.record(rule, kind, 'waiting for a decision')
            return


    def _run_conditional(self, flow, rule, action, kind, verdict, allowed, apply_one):
        """Runs the first branch whose conditions hold, or the ELSE.

        Shared by both phases: which actions are legal and how to apply one differ, the control
        flow does not, and two copies of "first match wins, stop at a terminal" is two chances for
        the halves to disagree about what a rule means.

        The branch taken is RECORDED, with the conditions that chose it. A rule that can take
        three different paths is only useful if the log says which one it took - otherwise
        "why did this call get a 401" is answered by re-reading the rule and guessing.
        """
        branches = action.get('__branches') or []
        for index, branch in enumerate(branches):
            try:
                holds = branch.holds(flow)
            except Exception as e:
                # A condition that throws is false, never fatal: proxying must survive a bad rule,
                # and "this branch did not match" is the safe reading of "we could not tell".
                print(f"[interception] rule {rule.name!r} condition failed, treating as no match: {e}")
                holds = False
            if holds:
                verdict.record(rule, kind, f'branch {index + 1} matched: {branch.describe()}')
                self._run_branch(flow, rule, branch.actions, verdict, allowed, apply_one)
                return

        otherwise = action.get('__otherwise') or []
        if otherwise:
            verdict.record(rule, kind, 'no branch matched - running the else')
            self._run_branch(flow, rule, otherwise, verdict, allowed, apply_one)
        else:
            verdict.record(rule, kind, 'no branch matched')

    def _run_branch(self, flow, rule, actions, verdict, allowed, apply_one):
        for nested in actions:
            nested_kind = nested.get('type')
            if nested_kind not in allowed:
                # A response action inside an IF_REQUEST has nothing to act on. The backend
                # refuses to save one; a hand-edited file gets it skipped rather than applied to
                # the wrong half.
                continue
            try:
                apply_one(flow, rule, nested, nested_kind, verdict)
            except Exception as e:
                print(f"[interception] rule {rule.name!r} action {nested_kind} failed, skipping: {e}")
                continue
            # Same stop conditions as the top-level loop - a terminal or a pause inside a branch
            # ends the phase exactly as it would outside one.
            if verdict.terminal or verdict.pause:
                return

    def apply_response(self, flow, service_name=None):
        verdict = Verdict()
        if flow.response is None:
            return verdict
        matching = self._matching(flow, service_name)
        if matching:
            verdict.observe_response(flow)
        for rule in matching:
            for action in rule.actions:
                kind = action.get('type')
                if kind not in RESPONSE_ACTIONS:
                    continue
                try:
                    self._apply_response_action(flow, rule, action, kind, verdict)
                except Exception as e:
                    print(f"[interception] rule {rule.name!r} action {kind} failed, skipping: {e}")
                    continue
                if verdict.pause:
                    return verdict
        return verdict

    def _apply_response_action(self, flow, rule, action, kind, verdict):
        response = flow.response

        if kind == 'IF_RESPONSE':
            self._run_conditional(flow, rule, action, kind, verdict, RESPONSE_ACTIONS,
                                  self._apply_response_action)
            return

        if kind == 'DELAY_RESPONSE':
            ms = _clamp_delay(action.get('durationMs'))
            if ms:
                verdict.delay_ms += ms
                verdict.record(rule, kind, f'{ms} ms')
            return

        if kind == 'SET_RESPONSE_STATUS':
            if set_status(response, action.get('status')):
                verdict.record(rule, kind, str(response.status_code))
            return

        if kind == 'SET_RESPONSE_HEADER':
            name = (action.get('name') or '').strip()
            if name:
                response.headers[name] = str(action.get('value', ''))
                verdict.record(rule, kind, name if not _sensitive(name) else f'{name} (value not logged)')
            return

        if kind == 'REMOVE_RESPONSE_HEADER':
            name = (action.get('name') or '').strip()
            if name and name in response.headers:
                del response.headers[name]
                verdict.record(rule, kind, name)
            return

        if kind == 'SET_RESPONSE_JSON_FIELD':
            updated = set_json_field(response.text, action.get('path'), action.get('value'))
            if updated is not None:
                response.text = updated
                verdict.record(rule, kind, str(action.get('path')))
            return

        if kind == 'SET_RESPONSE_BODY':
            # Whole body, any content type - the escape hatch for a payload that isn't JSON, or a
            # change too structural to express as a field path (a SOAP fault, an empty array).
            body = action.get('body')
            response.text = '' if body is None else str(body)
            verdict.record(rule, kind, f'{len(response.text)} bytes')
            return

        if kind == 'REPLACE_RESPONSE':
            # The counterpart of MOCK_RESPONSE, and the difference is the whole point: MOCK_RESPONSE
            # never opens a connection, so the supplier never sees the call and it is absent from
            # their logs and their rate limits. This one lets the real request happen, waits for the
            # real answer, and then hands the caller something else - so the upstream call is real,
            # logged and timed, while the client under test sees whatever you need it to see.
            if action.get('status') is not None:
                set_status(response, action.get('status'))
            headers = action.get('headers')
            if isinstance(headers, dict):
                for name, value in headers.items():
                    if str(name).strip():
                        response.headers[str(name)] = str(value)
            body = action.get('body')
            if body is not None:
                response.text = str(body)
            verdict.record(rule, kind, f'{response.status_code}, upstream was really called')
            return

        if kind == 'PAUSE_RESPONSE':
            verdict.pause = self._pause_spec(rule, action, 'response')
            verdict.record(rule, kind, 'waiting for a decision')
            return

    def _pause_spec(self, rule, action, phase):
        try:
            timeout = int(action.get('timeoutSeconds', 30))
        except (TypeError, ValueError):
            timeout = 30
        timeout = max(1, min(timeout, MAX_PAUSE_SECONDS))
        on_timeout = (action.get('onTimeout') or 'release').strip().lower()
        if on_timeout not in ('release', 'abort'):
            on_timeout = 'release'
        return {
            'phase': phase,
            'timeoutSeconds': timeout,
            'onTimeout': on_timeout,
            'ruleId': rule.id,
            'ruleName': rule.name,
        }


def apply_decision(flow, phase, decision):
    """Applies a human's decision from the breakpoint inspector back onto the flow.

    Shape (mirrors the backend's PausedCallDecision):
        {'action': 'release' | 'abort',
         'status': int|None, 'headers': {..}|None, 'body': str|None}

    Only the fields the user actually changed are present, so a release with nothing else set is
    byte-for-byte the same as never having paused. Returns a short description for the log.
    """
    if not isinstance(decision, dict):
        return None
    what = (decision.get('action') or 'release').strip().lower()
    if what == 'abort':
        return 'aborted by user'

    target = flow.response if phase == 'response' else flow.request
    if target is None:
        return 'released unchanged'

    changed = []
    status = decision.get('status')
    if phase == 'response' and status is not None and status != target.status_code:
        if set_status(target, status):
            changed.append(f'status {target.status_code}')

    headers = decision.get('headers')
    if isinstance(headers, dict):
        for name, value in headers.items():
            name = str(name).strip()
            if not name:
                continue
            if value is None:
                if name in target.headers:
                    del target.headers[name]
                    changed.append(f'-{name}')
            else:
                target.headers[name] = str(value)
                changed.append(name if not _sensitive(name) else f'{name} (value not logged)')

    body = decision.get('body')
    if body is not None:
        target.text = str(body)
        changed.append('body')

    if not changed:
        return 'released unchanged'
    return 'released edited: ' + ', '.join(changed)


def now_ms():
    return int(time.time() * 1000)
