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

import asyncio
import collections
import datetime
import email.utils
import json
import os
import re
import socket
import time
import urllib.parse
from http import HTTPStatus

import regex_worker

# Written by the backend's FileRulesPublisherAdapter, bind-mounted into both proxy containers -
# see docker-compose.yml. Absent is the normal state for a deployment that has never created a
# rule, and must stay indistinguishable from "no rules".
RULES_FILE = os.environ.get('INTERCEPTION_RULES_FILE', '/home/mitmproxy/interception-rules.json')

# A delay is the one action that can hold a connection open for an unbounded time by accident -
# a typo of 600000 instead of 6000 is ten minutes of a held socket. Rules are validated
# backend-side too, but this is the last line of defence and it lives where the sleep happens.
MAX_DELAY_MS = int(os.environ.get('INTERCEPTION_MAX_DELAY_MS', '120000'))

# The longest find/replace pattern accepted, unless the snapshot's `limits` says otherwise. The
# backend enforces the same number at save time (PatternSafety).
MAX_PATTERN_LENGTH = 500

# How long a paused call may hold its caller open before it is released by the timeout rule.
# Backend validation caps the per-rule value against this as well.
MAX_PAUSE_SECONDS = int(os.environ.get('INTERCEPTION_MAX_PAUSE_SECONDS', '300'))

REQUEST_ACTIONS = {
    'DELAY_REQUEST', 'SET_REQUEST_HEADER', 'REMOVE_REQUEST_HEADER',
    'SET_REQUEST_TRAILER', 'REMOVE_REQUEST_TRAILER',
    'SET_QUERY_PARAM', 'REMOVE_QUERY_PARAM', 'SET_REQUEST_JSON_FIELD',
    'REPLACE_IN_REQUEST_BODY', 'REWRITE_URL', 'SET_METHOD',
    'REMOVE_REQUEST_JSON_FIELD', 'SET_REQUEST_BODY',
    'SET_REQUEST_COOKIE', 'REMOVE_REQUEST_COOKIE', 'SET_FORM_FIELD', 'REMOVE_FORM_FIELD',
    'DISABLE_CACHE', 'DISABLE_COMPRESSION', 'ANSWER_WITH_RECORDED_CALL', 'ANSWER_WITH_FILE',
    'ABORT_REQUEST', 'MOCK_RESPONSE', 'PAUSE_REQUEST', 'SEND_TO_HOST',
    'SIMULATE_FAILURE', 'IF_REQUEST',
}
RESPONSE_ACTIONS = {
    'DELAY_RESPONSE', 'SET_RESPONSE_STATUS', 'SET_RESPONSE_HEADER',
    'REMOVE_RESPONSE_HEADER', 'SET_RESPONSE_TRAILER', 'REMOVE_RESPONSE_TRAILER',
    'SET_RESPONSE_JSON_FIELD', 'SET_RESPONSE_BODY',
    'REPLACE_IN_RESPONSE_BODY', 'REMOVE_RESPONSE_JSON_FIELD',
    'SET_RESPONSE_COOKIE', 'REMOVE_RESPONSE_COOKIE', 'SET_RESPONSE_ENCODING',
    'REPLACE_WITH_RECORDED_RESPONSE',
    'REPLACE_RESPONSE', 'PAUSE_RESPONSE', 'IF_RESPONSE',
}

# A WebSocket message action runs once per message, after the handshake - a third lane alongside
# REQUEST_ACTIONS/RESPONSE_ACTIONS (see ActionType.Phase.MESSAGE in the backend).
MESSAGE_ACTIONS = {'REPLACE_IN_MESSAGE', 'DROP_MESSAGE', 'DELAY_MESSAGE'}

def _known_action(kind):
    """Whether ANY phase of this engine understands `kind`. Anything else came from a rules file
    newer than this proxy, and is recorded as skipped rather than silently ignored."""
    return kind in REQUEST_ACTIONS or kind in RESPONSE_ACTIONS or kind in MESSAGE_ACTIONS


# An action that ends the request phase: there is no upstream request left for a later rule to
# modify, so evaluation stops rather than silently applying edits to something already gone.
TERMINAL_REQUEST_ACTIONS = {'ABORT_REQUEST', 'MOCK_RESPONSE', 'SIMULATE_FAILURE', 'ANSWER_WITH_RECORDED_CALL',
                             'ANSWER_WITH_FILE'}

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

# The request headers that let a server answer 304 Not Modified. DISABLE_CACHE removes exactly these
# - the same two mitmproxy's anticache() removes - so the full response always comes back.
CONDITIONAL_HEADERS = ('if-none-match', 'if-modified-since')

# What SET_RESPONSE_ENCODING can produce: the Content-Encodings mitmproxy's encode() supports,
# plus identity for "no compression". The mirror of the backend validator's list.
RESPONSE_ENCODINGS = {'gzip', 'deflate', 'br', 'zstd', 'identity'}

# Header names whose VALUE is never written into an interception record. The record says a header
# was set and names it; the value would end up in the call log, in every export, and in the
# Flagged Issues section that echoes stored text verbatim - the same constraint
# redaction.model.ts states for redactions, for the same reason.
SENSITIVE_HEADERS = {
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
    'x-api-key', 'api-key', 'x-auth-token', 'authentication',
}


def _sensitive(name, names=None):
    return (name or '').strip().lower() in (SENSITIVE_HEADERS if names is None else names)


def mask_value(value):
    """What a secret value becomes in an interception record. The length is kept so a reader can
    still tell a token was swapped for one of a different size; the value itself never is."""
    return f'(value not logged · {len(str(value or ""))} chars)'


def _masked_snapshot(snapshot, names):
    """A copy of a snapshot with every sensitive header's value masked. Applied only when the
    record is written (Verdict.as_log), never to the working snapshots: comparing masked copies
    would miss a secret swapped for another of the same length, and the before/after would
    silently vanish for exactly the edits a tester most wants to see."""
    if not snapshot or not snapshot.get('headers'):
        return snapshot
    masked = dict(snapshot)
    masked['headers'] = {k: (mask_value(v) if _sensitive(k, names) else v)
                         for k, v in snapshot['headers'].items()}
    if snapshot.get('trailers') is not None:
        masked['trailers'] = {k: (mask_value(v) if _sensitive(k, names) else v)
                              for k, v in snapshot['trailers'].items()}
    return masked


# The two headers Alfred's own resend feature (backend-resend) adds so the resent call can be
# linked back to its original - see docs/interception.md. Named after Alfred, not mitmproxy: a
# client sending these on an ordinary call must never be able to make it masquerade as a resend.
RESEND_OF_HEADER = 'X-Alfred-Resend-Of'
RESEND_EDITS_HEADER = 'X-Alfred-Resend-Edits'


def take_resend_headers(flow, backend_addresses):
    """Pops X-Alfred-Resend-Of/X-Alfred-Resend-Edits off the request - always, so neither a rule
    nor the call log ever sees them, and a rule matching on either header can never fire - and
    returns (resend_of, resend_edits) only when the caller that set them really is Alfred's own
    backend, identified by the peer address of the connection carrying the request. A client could
    otherwise forge either header to make an ordinary call masquerade as a resend of another.

    resend_edits arrives as a JSON string (backend-resend's ResendEdits, serialized); a value that
    fails to parse is treated as absent rather than raised, since a malformed header must not take
    the whole call down with it.
    """
    headers = flow.request.headers
    resend_of = headers.get(RESEND_OF_HEADER)
    resend_edits_raw = headers.get(RESEND_EDITS_HEADER)
    if RESEND_OF_HEADER in headers:
        del headers[RESEND_OF_HEADER]
    if RESEND_EDITS_HEADER in headers:
        del headers[RESEND_EDITS_HEADER]

    peer = getattr(flow.client_conn, 'peername', None)
    if not peer or peer[0] not in (backend_addresses or ()):
        return None, None

    resend_edits = None
    if resend_edits_raw:
        try:
            resend_edits = json.loads(resend_edits_raw)
        except (TypeError, ValueError):
            resend_edits = None
    return (resend_of or None), resend_edits


def resolve_backend_addresses(backend_host=None):
    """The IP addresses BACKEND_HOST currently resolves to, refreshed once per addon startup -
    resolved by IP rather than by hostname because flow.client_conn.peername is always an IP.
    Returns an empty tuple (never raises) when the host can't be resolved yet, e.g. before Docker's
    embedded DNS has the backend container's name - the resend headers are then simply never
    trusted until the next process restart, rather than crashing the addon."""
    host = backend_host if backend_host is not None else os.environ.get('BACKEND_HOST', 'backend')
    try:
        return tuple(socket.gethostbyname_ex(host)[2])
    except OSError:
        return ()


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
    trailers = getattr(message, 'trailers', None)
    if trailers is not None:
        snapshot['trailers'] = dict(trailers)
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

    __slots__ = ('source', 'service_names', 'methods', 'host', 'path_contains', 'path_regex', 'tests', 'body_tests')

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
        # Header, query and cookie tests, flattened into one tuple so matching is a single loop.
        # Empty for every rule saved before they existed, which then costs nothing extra.
        self.tests = tuple(
            test
            for where in ('headers', 'query', 'cookies')
            for test in (_MatchTest.parse(where, one) for one in (raw.get(where) or []))
            if test is not None
        )
        # Request-body tests: read the body, so after everything else - and parsed here, once.
        self.body_tests = tuple(_BodyTest(one) for one in (raw.get('body') or []) if isinstance(one, dict))

    def matches(self, source, service_name, method, host, path, request=None):
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
        # Last: the only checks that read the call's headers, and only reached by a call every
        # cheaper check above already let through.
        if self.tests:
            cookies = None
            for test in self.tests:
                if test.where == 'cookies':
                    if cookies is None:
                        cookies = _request_cookies(request)
                    value = cookies.get(test.name)
                elif test.where == 'headers':
                    value = request.headers.get(test.name)
                else:
                    value = request.query.get(test.name)
                if not test.holds(value):
                    return False
        if self.body_tests:
            text = _body(request)
            for test in self.body_tests:
                if not test.holds(request, text):
                    return False
        return True


class _MatchTest:
    """One header, query or cookie test of a rule's match. MATCHES is compiled once, here, like
    pathRegex - never per call."""

    __slots__ = ('where', 'name', 'operator', 'value', 'folded', 'regex')

    OPERATORS = {'EXISTS', 'NOT_EXISTS', 'EQUALS', 'CONTAINS', 'MATCHES'}

    @classmethod
    def parse(cls, where, raw):
        if not isinstance(raw, dict):
            return None
        name = str(raw.get('name') or '').strip()
        operator = str(raw.get('operator') or '').strip().upper()
        if not name or operator not in cls.OPERATORS:
            return None
        test = cls()
        test.where = where
        # Cookies compare names exactly, as browsers do; header names are case-insensitive through
        # mitmproxy's Headers itself.
        test.name = name
        test.operator = operator
        value = raw.get('value')
        test.value = None if value is None else str(value)
        test.folded = raw.get('caseSensitive') is False
        test.regex = None
        if operator == 'MATCHES':
            if test.value is None or len(test.value) > MAX_PATTERN_LENGTH:
                return None
            test.regex = re.compile(test.value, re.IGNORECASE if test.folded else 0)
        elif test.folded and test.value is not None:
            test.value = test.value.lower()
        return test

    def holds(self, actual):
        if self.operator == 'EXISTS':
            return actual is not None
        if self.operator == 'NOT_EXISTS':
            return actual is None
        if actual is None or self.value is None and self.regex is None:
            return False
        actual = str(actual)
        if self.operator == 'MATCHES':
            return self.regex.search(actual) is not None
        if self.folded:
            actual = actual.lower()
        if self.operator == 'EQUALS':
            return actual == self.value
        return self.value in actual


MAX_BODY_TEST_CHARS = 1_000_000  # mirrors RuleValidator.MAX_BODY_TEST_CHARS


def _squash_json(text):
    """JSON text with every whitespace character OUTSIDE a string removed - so a pretty-printed
    document, or a fragment of one ("currency": "EUR"), compares equal to its minified form."""
    out = []
    in_string = escaped = False
    for ch in text:
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
            out.append(ch)
        elif not ch.isspace():
            out.append(ch)
    return ''.join(out)


_BETWEEN_TAGS = re.compile(r'>\s+<')


def _squash_xml(text):
    """XML with the whitespace between tags removed and the ends trimmed - indentation only."""
    return _BETWEEN_TAGS.sub('><', text.strip())


def _body_kind(text):
    """'json' / 'xml' / None, by the first character that is not whitespace."""
    head = text.lstrip()[:1]
    if head in ('{', '['):
        return 'json'
    if head == '<':
        return 'xml'
    return None


class _BodyTest:
    """One request-body test of a rule's match: the whole text (BODY), a JSON field, or the size.

    The comparison is Condition's - the evaluator IF_REQUEST uses on REQUEST_BODY and
    REQUEST_JSON_FIELD - so "contains" means one thing everywhere. With ignoreFormatting (the
    default) both the value and the call's body are squashed the same way first - JSON outside its
    strings, XML between its tags - so a pretty-printed value matches a minified call. A test the
    engine cannot use never holds: a rule that matched because its test was ignored would apply to
    far more traffic than was written.
    """

    __slots__ = ('kind', 'path', 'valid', 'squash', 'negative', 'by_form')

    def __init__(self, raw):
        self.kind = str(raw.get('kind') or '').strip().upper()
        self.path = str(raw.get('path') or '').strip() or None
        operator = str(raw.get('operator') or '').strip().upper()
        value = raw.get('value')
        value = None if value is None else str(value)
        self.valid = (
            self.kind in ('BODY', 'JSON_FIELD', 'SIZE')
            and operator in OPERATORS
            and (self.kind != 'JSON_FIELD' or self.path is not None)
            and (value is None or len(value) <= MAX_BODY_TEST_CHARS)
        )
        textual = operator not in ('MATCHES', 'NOT_MATCHES', 'AT_LEAST', 'AT_MOST', 'EXISTS', 'NOT_EXISTS')
        self.squash = self.kind != 'SIZE' and textual and value is not None and raw.get('ignoreFormatting') is not False
        self.negative = operator.startswith('NOT_')
        case = raw.get('caseSensitive') is not False
        subject = 'REQUEST_JSON_FIELD' if self.kind == 'JSON_FIELD' else 'REQUEST_BODY'

        def condition(v):
            return Condition({'subject': subject, 'name': self.path, 'operator': operator, 'value': v, 'caseSensitive': case})

        # Prepared once per form, so nothing is squashed or compiled per call.
        try:
            self.by_form = {None: condition(value)}
            if self.squash:
                self.by_form['json'] = condition(_squash_json(value))
                self.by_form['xml'] = condition(_squash_xml(value))
        except re.error:
            self.valid = False
            self.by_form = {}

    def _either(self, raw_values, form, squashed_values):
        """The raw value against the raw text, and the squashed value against the squashed text.
        Both, because squashing a plain value would also squash it: `New York` is a phrase inside
        a JSON string, and "contains New York" must still hold. A positive operator holds when
        either reading does; a negative one only when both do - so a test and its negation can
        never both hold."""
        results = [self.by_form[None].holds_values(raw_values)]
        if form is not None:
            results.append(self.by_form[form].holds_values(squashed_values))
        return all(results) if self.negative else any(results)

    def holds(self, request, text):
        if not self.valid:
            return False
        if self.kind == 'SIZE':
            try:
                size = len(request.content or b'')
            except Exception:
                size = len((text or '').encode('utf-8'))
            return self.by_form[None].holds_values([str(size)])
        if self.kind == 'JSON_FIELD':
            found = get_json_field(text, self.path)
            raw_values = [_as_text(v) for v in found]
            if not self.squash:
                return self.by_form[None].holds_values(raw_values)
            # Only an object or array has formatting; a string field is compared as it is.
            squashed = [v if isinstance(f, str) else _squash_json(v) for f, v in zip(found, raw_values)]
            return self._either(raw_values, 'json', squashed)
        if not text:
            # An empty body is no body - EXISTS fails and "does not contain" holds.
            return self.by_form[None].holds_values([])
        form = _body_kind(text) if self.squash else None
        if form is None:
            return self.by_form[None].holds_values([text])
        squashed = _squash_json(text) if form == 'json' else _squash_xml(text)
        return self._either([text], form, [squashed])


def _request_cookies(request):
    """name -> value for the request's cookies, first occurrence winning. Parsed from the raw
    header rather than request.cookies so a test reads exactly what edit_cookie_header edits."""
    out = {}
    if request is None:
        return out
    for piece in '; '.join(request.headers.get_all('cookie')).split(';'):
        name, eq, value = piece.partition('=')
        name = name.strip()
        if name and eq and name not in out:
            out[name] = value.strip()
    return out


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


class _Pattern:
    """One action's find/replace pattern, prepared once at rule load.

    LITERAL by default: the pattern matches as the text it is, so `$10.00` or `(beta)` mean what
    they say. That path is linear and runs right here. Regex is opt-in, and only a regex goes to
    regex_worker, the one place a runaway backtrack can be stopped (see that module for why a
    process). The backend refuses the dangerous shapes before they are ever published; this
    class still re-checks the length, because the file on disk is the last word.
    """

    __slots__ = ('pattern', 'replacement', 'regex', 'case_sensitive', 'count', 'timeout_ms',
                 'error', '_literal_ci', '_flags')

    def __init__(self, action, limits=None):
        limits = limits or {}
        self.pattern = str(action.get('pattern') or '')
        self.replacement = str(action.get('replacement') or '')
        self.regex = action.get('regex') is True
        self.case_sensitive = action.get('caseSensitive') is not False
        self.count = _positive_int(action.get('maxReplacements'))
        self.timeout_ms = _positive_int(limits.get('regexTimeoutMs')) or regex_worker.DEFAULT_TIMEOUT_MS
        self._flags = 0 if self.case_sensitive else re.IGNORECASE
        self._literal_ci = None
        self.error = None
        max_length = _positive_int(limits.get('maxPatternLength')) or MAX_PATTERN_LENGTH
        if not self.pattern:
            self.error = 'no pattern'
        elif len(self.pattern) > max_length:
            self.error = f'pattern longer than {max_length} characters'
        elif self.regex:
            try:
                # Compiling is cheap and cannot backtrack; only MATCHING can run away. A pattern
                # that does not compile is caught here, once, instead of on every call.
                re.compile(self.pattern, self._flags)
            except re.error as e:
                self.error = f'invalid regex: {e}'
        elif not self.case_sensitive:
            # An escaped literal has no quantifiers, so this stays linear and safe in-process.
            self._literal_ci = re.compile(re.escape(self.pattern), re.IGNORECASE)

    async def replace(self, text):
        """Returns (new_text, n, reason). new_text is None whenever nothing may be written back -
        no match, a timeout, an unusable pattern - so the caller leaves the body byte-identical,
        and `reason` says why for the record."""
        if self.error:
            return None, 0, self.error
        if not text:
            return None, 0, 'empty body'
        if self.regex:
            new_text, n, timed_out = await regex_worker.sub(
                self.pattern, self._flags, self.replacement, text, self.count, self.timeout_ms)
            if timed_out:
                return None, 0, f'pattern timed out after {self.timeout_ms} ms'
        elif self._literal_ci is not None:
            # A function, not a string, as the replacement: a literal replacement must never have
            # its backslashes read as group references.
            new_text, n = self._literal_ci.subn(lambda _m: self.replacement, text, count=self.count)
        else:
            n = text.count(self.pattern)
            if self.count:
                n = min(n, self.count)
            new_text = text.replace(self.pattern, self.replacement, self.count or -1) if n else text
        if not n:
            return None, 0, 'no match'
        return new_text, n, None


def _unbuffered(message):
    """True when mitmproxy is streaming this body rather than holding it. A streamed body is not
    here to edit - the bytes have already gone - so a body action must skip it outright rather
    than rewrite whatever fragment it can see."""
    return bool(getattr(message, 'stream', False)) or getattr(message, 'raw_content', b'') is None


async def _replace_in_body(message, rule, action, kind, verdict):
    """REPLACE_IN_REQUEST_BODY / REPLACE_IN_RESPONSE_BODY.

    Read and written through .text, as SET_*_JSON_FIELD is: mitmproxy decodes the content-encoding
    for us, and assigning .text re-encodes to the same encoding and fixes Content-Length. Nothing
    is assigned unless something matched, so an unmatched body goes out byte-for-byte as it came.
    """
    if _unbuffered(message):
        verdict.skip(rule, kind, 'body was streamed, not buffered')
        return
    try:
        text = message.text
    except ValueError:
        verdict.skip(rule, kind, 'body is not text')
        return
    pattern = action.get('__pattern') or _Pattern(action)
    new_text, n, reason = await pattern.replace(text)
    if new_text is None:
        verdict.skip(rule, kind, reason)
        return
    message.text = new_text
    # The count, never the pattern or the replacement: either could be a token somebody typed in.
    verdict.record(rule, kind, f'{n} replacement' + ('' if n == 1 else 's'))


async def _rewrite_url(request, rule, action, kind, verdict):
    """REWRITE_URL: send the call somewhere else.

    mitmproxy's host/port setters rewrite the Host header to follow the new target, which is the
    default; keepHostHeader puts the client's original back. The rewrite is checked against
    Alfred's own addresses AFTER it is applied, because a pattern's result is only known now -
    the backend already refused a structured target that is Alfred, this catches the rest.
    """
    before = request.url
    original_host_header = request.host_header
    target = action.get('target') if isinstance(action.get('target'), dict) else {}
    parts = {k: target.get(k) for k in ('scheme', 'host', 'port', 'path') if target.get(k) not in (None, '')}

    if parts:
        scheme = str(parts.get('scheme') or '').strip().lower()
        if scheme in ('http', 'https'):
            request.scheme = scheme
        if parts.get('host'):
            request.host = str(parts['host']).strip()
        if parts.get('port'):
            try:
                request.port = int(parts['port'])
            except (TypeError, ValueError):
                pass
        if parts.get('path'):
            # request.path carries the query string too; a path rewrite keeps the query as it was.
            query = request.path.partition('?')[2]
            request.path = str(parts['path']) + (f'?{query}' if query else '')
    elif action.get('pattern') is not None:
        pattern = action.get('__pattern') or _Pattern(action)
        new_url, _n, reason = await pattern.replace(before)
        if new_url is None:
            verdict.skip(rule, kind, reason)
            return
        request.url = new_url
    else:
        verdict.skip(rule, kind, 'no target given')
        return

    if _is_self_target(request.host, request.port, verdict.self_targets):
        refused = f'{request.host}:{request.port}'
        request.url = before
        request.host_header = original_host_header
        verdict.record(rule, kind, f'refused - target {refused} is Alfred itself')
        return
    if action.get('keepHostHeader') is True and original_host_header is not None:
        request.host_header = original_host_header

    after = request.url
    if after == before:
        verdict.skip(rule, kind, 'target unchanged')
        return
    verdict.record(rule, kind, f'{_masked_url(before, verdict)} → {_masked_url(after, verdict)}')


def _is_self_target(host, port, targets):
    host = (host or '').strip().lower()
    return bool(host) and (host in targets or f'{host}:{port}' in targets)


def _masked_url(url, verdict):
    """A URL fit for the record: a query parameter whose name is a secret one keeps its name only."""
    base, sep, query = (url or '').partition('?')
    if not sep:
        return url
    pieces = []
    for pair in query.split('&'):
        name, eq, value = pair.partition('=')
        pieces.append(f'{name}={mask_value(value)}' if eq and verdict.masks(name) else pair)
    return f'{base}?{"&".join(pieces)}'


def edit_cookie_header(header, name, value):
    """A Cookie header with one cookie set (value) or removed (value None), and every other cookie
    left exactly as it was - separators, spacing and order included.

    mitmproxy's request.cookies view is deliberately not used: it re-serialises every cookie on
    write, so a tester dropping `consent` would also see `session` re-quoted or re-spaced, and the
    point of the edit is that nothing else moves. A cookie named twice is set once and its
    duplicates dropped, because a server reading the second copy would never see the edit.
    """
    out, found = [], False
    for piece in (header.split(';') if header else []):
        if piece.split('=', 1)[0].strip() != name:
            out.append(piece)
            continue
        if found or value is None:
            found = True
            continue
        found = True
        lead = piece[:len(piece) - len(piece.lstrip())]
        out.append(f'{lead}{name}={value}')
    if not found and value is not None:
        out.append(f'{" " if out else ""}{name}={value}')
    return ';'.join(out).lstrip()


def _set_cookie_name(line):
    return (line or '').split(';', 1)[0].split('=', 1)[0].strip()


def set_cookie_line(name, value, attributes=None):
    """A Set-Cookie value, attributes in the order RFC 6265 lists them. Only what the rule states
    is written: an attribute left empty is absent, not defaulted."""
    attributes = attributes if isinstance(attributes, dict) else {}
    parts = [f'{name}={value}']
    if attributes.get('path'):
        parts.append(f"Path={attributes['path']}")
    if attributes.get('domain'):
        parts.append(f"Domain={attributes['domain']}")
    if attributes.get('maxAge') is not None:
        try:
            parts.append(f"Max-Age={int(attributes['maxAge'])}")
        except (TypeError, ValueError):
            pass
    if attributes.get('secure') is True:
        parts.append('Secure')
    if attributes.get('httpOnly') is True:
        parts.append('HttpOnly')
    if attributes.get('sameSite'):
        parts.append(f"SameSite={attributes['sameSite']}")
    return '; '.join(parts)


def _cookie_detail(name, value):
    # A cookie value is a session more often than not, so it is never written into the record -
    # the same reason `cookie` and `set-cookie` are on the secret header list.
    return name if value is None else f'{name} {mask_value(value)}'


def _edit_request_cookie(request, rule, action, kind, verdict):
    name = str(action.get('name') or '').strip()
    if not name:
        verdict.skip(rule, kind, 'no cookie name')
        return
    value = None if kind == 'REMOVE_REQUEST_COOKIE' else str(action.get('value', ''))
    # HTTP/2 may split cookies over several Cookie headers; they are one list, joined as RFC 7540
    # says, and written back as one header.
    current = '; '.join(request.headers.get_all('cookie'))
    updated = edit_cookie_header(current, name, value)
    if updated == current:
        verdict.skip(rule, kind, 'no such cookie' if value is None else 'already set')
        return
    if updated:
        request.headers.set_all('cookie', [updated])
    else:
        del request.headers['cookie']
    verdict.record(rule, kind, _cookie_detail(name, value))


def _edit_response_cookie(response, rule, action, kind, verdict):
    """Set replaces the Set-Cookie of the same name where it stood, or appends one; remove drops
    it. Every other Set-Cookie line is kept as the supplier sent it."""
    name = str(action.get('name') or '').strip()
    if not name:
        verdict.skip(rule, kind, 'no cookie name')
        return
    lines = response.headers.get_all('set-cookie')
    if kind == 'REMOVE_RESPONSE_COOKIE':
        kept = [line for line in lines if _set_cookie_name(line) != name]
        if len(kept) == len(lines):
            verdict.skip(rule, kind, 'no such cookie')
            return
        response.headers.set_all('set-cookie', kept)
        verdict.record(rule, kind, name)
        return

    value = str(action.get('value', ''))
    line = set_cookie_line(name, value, action.get('cookieAttributes'))
    updated, placed = [], False
    for existing in lines:
        if _set_cookie_name(existing) != name:
            updated.append(existing)
        elif not placed:
            updated.append(line)
            placed = True
    if not placed:
        updated.append(line)
    if updated == lines:
        verdict.skip(rule, kind, 'already set')
        return
    response.headers.set_all('set-cookie', updated)
    attributes = line.partition('; ')[2]
    verdict.record(rule, kind, _cookie_detail(name, value) + (f'; {attributes}' if attributes else ''))


def edit_urlencoded(text, name, value):
    """A urlencoded body with one field set or removed (value None), every other pair left byte for
    byte. None when there was nothing to remove. Hand-rolled for the same reason as
    edit_cookie_header: request.urlencoded_form re-encodes every pair on write."""
    out, found = [], False
    for pair in (text.split('&') if text else []):
        if urllib.parse.unquote_plus(pair.split('=', 1)[0]) != name:
            out.append(pair)
            continue
        if found or value is None:
            found = True
            continue
        found = True
        out.append(f'{urllib.parse.quote_plus(name)}={urllib.parse.quote_plus(value)}')
    if not found:
        if value is None:
            return None
        out.append(f'{urllib.parse.quote_plus(name)}={urllib.parse.quote_plus(value)}')
    return '&'.join(out)


_PART_NAME = re.compile(rb'(?i)\bname=(?:"([^"]*)"|([^;\s]+))')
_PART_FILENAME = re.compile(rb'(?i)\bfilename\*?=')
_BOUNDARY = re.compile(r'(?i)\bboundary=(?:"([^"]+)"|([^;\s]+))')


def _part_disposition(head):
    """(field name, is a file) for one multipart part's header block, or None without one."""
    for line in head.split(b'\r\n'):
        if line.lower().startswith(b'content-disposition:'):
            found = _PART_NAME.search(line)
            if not found:
                return None
            raw = found.group(1) if found.group(1) is not None else found.group(2)
            return raw.decode('utf-8', 'replace'), bool(_PART_FILENAME.search(line))
    return None


def edit_multipart(content, content_type, name, value):
    """A multipart/form-data body with one text field set or removed. Returns (body, None), or
    (None, reason) when nothing was changed.

    Edited at the byte level, part by part, rather than through request.multipart_form: that
    setter re-encodes every part with a bare `name=` disposition, so a file part would lose its
    filename and content type - the upload the tester was not touching would break. Here every
    part but the edited one is copied through untouched, and a file part is never edited.
    """
    found_boundary = _BOUNDARY.search(content_type or '')
    if not found_boundary:
        return None, 'no multipart boundary'
    boundary = (found_boundary.group(1) or found_boundary.group(2)).encode('ascii', 'replace')
    delimiter = b'--' + boundary
    encoded = None if value is None else value.encode('utf-8')
    if encoded is not None and delimiter in encoded:
        return None, 'the value contains the multipart boundary'
    segments = (content or b'').split(delimiter)
    if len(segments) < 3:
        return None, 'not a form'
    parts, found = [], False
    for part in segments[1:-1]:
        head, sep, _body = part.partition(b'\r\n\r\n')
        disposition = _part_disposition(head)
        if not disposition or disposition[0] != name:
            parts.append(part)
            continue
        if disposition[1]:
            return None, 'a file part, left untouched'
        if found or encoded is None:
            found = True
            continue
        found = True
        parts.append(head + sep + encoded + b'\r\n')
    if not found:
        if encoded is None:
            return None, 'no such field'
        head = b'\r\nContent-Disposition: form-data; name="' + name.encode('utf-8') + b'"'
        parts.append(head + b'\r\n\r\n' + encoded + b'\r\n')
    return segments[0] + b''.join(delimiter + part for part in parts) + delimiter + segments[-1], None


def _edit_form_field(request, rule, action, kind, verdict):
    name = str(action.get('name') or '').strip()
    if not name or any(c in name for c in '"\r\n'):
        verdict.skip(rule, kind, 'no valid field name')
        return
    value = None if kind == 'REMOVE_FORM_FIELD' else str(action.get('value', ''))
    content_type = request.headers.get('content-type') or ''
    kind_of_form = content_type.split(';', 1)[0].strip().lower()
    if kind_of_form == 'application/x-www-form-urlencoded':
        text = request.text or ''
        updated = edit_urlencoded(text, name, value)
        if updated is None:
            verdict.skip(rule, kind, 'no such field')
            return
        if updated == text:
            verdict.skip(rule, kind, 'already set')
            return
        request.text = updated
    elif kind_of_form == 'multipart/form-data':
        updated, reason = edit_multipart(request.content, content_type, name, value)
        if updated is None:
            verdict.skip(rule, kind, reason)
            return
        if updated == request.content:
            verdict.skip(rule, kind, 'already set')
            return
        request.content = updated
    else:
        verdict.skip(rule, kind, 'not a form')
        return
    # The body itself is in the before/after snapshot, so masking here only hides what a secret
    # field name says it should - the same rule as a query parameter.
    verdict.record(rule, kind, verdict.named(name, value))


def _positive_int(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


class Rule:
    __slots__ = ('id', 'name', 'enabled', 'priority', 'stop_processing', 'match', 'actions')

    def __init__(self, raw, limits=None):
        self.id = str(raw.get('id') or '')
        self.name = raw.get('name') or '(unnamed rule)'
        self.enabled = raw.get('enabled', True) is not False
        try:
            self.priority = int(raw.get('priority', 100))
        except (TypeError, ValueError):
            self.priority = 100
        self.stop_processing = raw.get('stopProcessing', False) is True
        self.match = Match(raw.get('match'))
        self.actions = _prepare_actions(raw.get('actions'), limits)


def _prepare_actions(raw_actions, limits=None):
    """Keeps actions as the plain dicts the engine reads, with one addition: a conditional gets its
    branches parsed into Branch objects under a private key.

    Done at LOAD time, once, because that is when a regex can be compiled and a malformed branch
    can be dropped - doing either per request would put the cost on every call the rule matches.
    The private key is stored on the dict we parsed rather than in a side table keyed by identity,
    which would be fragile for no benefit; nothing ever re-serialises these dicts.

    An action with `enabled: false` is dropped here, at load time, rather than checked on every
    request - the same reasoning as the regex. Dropping it is also what makes disabling a
    conditional disable everything nested inside it for free: its branches and otherwise are never
    even parsed, so there is nothing left to separately skip.
    """
    prepared = []
    for action in (raw_actions or []):
        if not isinstance(action, dict) or not action.get('type'):
            continue
        if action.get('enabled') is False:
            continue
        if action['type'] in ('IF_REQUEST', 'IF_RESPONSE'):
            action['__branches'] = [Branch(b, limits) for b in (action.get('branches') or []) if isinstance(b, dict)]
            action['__otherwise'] = _prepare_actions(action.get('otherwise'), limits)
        if action.get('pattern') is not None:
            # Every action that finds text (body, URL, message) shares one pattern engine.
            action['__pattern'] = _Pattern(action, limits)
        prepared.append(action)
    return prepared


class RuleSet:
    """The parsed snapshot. `enabled` is the master switch - one flag that turns the whole feature
    off without touching a single rule, which is what the UI's "Turn all off" writes."""

    __slots__ = ('enabled', 'rules', 'error', 'sensitive', 'self_targets', 'limits')

    def __init__(self, enabled=False, rules=None, error=None, sensitive=None, self_targets=None,
                 limits=None):
        self.enabled = enabled
        self.rules = rules or []
        self.error = error
        # Published by the backend so the secret-name list has one owner
        # (backend-interception's SensitiveHeaders). A snapshot from an older backend has none,
        # and falls back to the built-in list rather than masking nothing.
        self.sensitive = frozenset(sensitive) if sensitive else frozenset(SENSITIVE_HEADERS)
        self.self_targets = frozenset(self_targets or ())
        self.limits = limits or {}

    @property
    def inert(self):
        return not self.enabled or not self.rules


EMPTY_RULESET = RuleSet()


# Stored answers are published by the backend beside the snapshot, as answers/<id>.meta.json and
# answers/<id>.body. The id is a file name, so it must be exactly a canonical UUID before it is
# joined onto the directory - this pattern is the proxy's half of the FR-024 path-traversal guard.
ANSWER_ID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
ANSWER_CACHE_BYTES = int(os.environ.get('INTERCEPTION_ANSWER_CACHE_BYTES', str(32 * 1024 * 1024)))


class _AnswerCache:
    """Stored answers read from disk once and kept in memory, least recently used first out, up to
    ANSWER_CACHE_BYTES of bodies. An entry is re-read when its meta file's mtime changes.

    The read itself runs in a thread: a body can be 10 MB, and reading it on the event loop would
    stall every connection this proxy carries for the duration."""

    def __init__(self, directory, cap_bytes=None):
        self._dir = directory
        self._cap = ANSWER_CACHE_BYTES if cap_bytes is None else cap_bytes
        self._entries = collections.OrderedDict()   # id -> (mtime, meta, body)
        self._bytes = 0

    async def load(self, answer_id):
        """(meta, body) for a stored answer, or (None, reason) when there is none to serve."""
        answer_id = str(answer_id or '')
        if not ANSWER_ID.fullmatch(answer_id):
            return None, 'invalid stored answer id'
        meta_path = os.path.join(self._dir, answer_id + '.meta.json')
        try:
            mtime = os.path.getmtime(meta_path)
        except OSError:
            self._forget(answer_id)
            return None, f'stored answer {answer_id} not found'
        cached = self._entries.get(answer_id)
        if cached is not None and cached[0] == mtime:
            self._entries.move_to_end(answer_id)
            return (cached[1], cached[2]), None
        try:
            meta, body = await asyncio.to_thread(self._read, answer_id, meta_path)
        except (OSError, ValueError):
            self._forget(answer_id)
            return None, f'stored answer {answer_id} not found'
        self._remember(answer_id, mtime, meta, body)
        return (meta, body), None

    def _read(self, answer_id, meta_path):
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f)
        with open(os.path.join(self._dir, answer_id + '.body'), 'rb') as f:
            body = f.read()
        if not isinstance(meta, dict):
            raise ValueError('meta is not an object')
        return meta, body

    def _remember(self, answer_id, mtime, meta, body):
        self._forget(answer_id)
        if len(body) > self._cap:
            return  # served, but too big to keep
        self._entries[answer_id] = (mtime, meta, body)
        self._bytes += len(body)
        while self._bytes > self._cap and self._entries:
            _, (_, _, evicted) = self._entries.popitem(last=False)
            self._bytes -= len(evicted)

    def _forget(self, answer_id):
        old = self._entries.pop(answer_id, None)
        if old is not None:
            self._bytes -= len(old[2])


def answer_parts(meta, body, action):
    """status, headers and body for a stored answer, with the action's own status winning."""
    status = action.get('status')
    if status is None:
        status = meta.get('status')
    try:
        status = int(status)
    except (TypeError, ValueError):
        status = 200
    headers = meta.get('headers') if isinstance(meta.get('headers'), dict) else {}
    return status, {str(k): str(v) for k, v in headers.items()}, body


def recorded_epoch(meta):
    """When a recorded answer was recorded, as epoch seconds, or None when it cannot be told."""
    value = meta.get('recordedAt')
    if not value:
        return None
    try:
        return email.utils.parsedate_to_datetime(str(value)).timestamp()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return None


def refresh_dates(response, recorded_at):
    """Moves Date, Expires, Last-Modified and cookie expiry forward by the time since recording, so
    a recorded answer does not arrive already expired. mitmproxy's own refresh() does the shifting,
    measured from timestamp_start - which is set to the recording time for the call, then put back."""
    if recorded_at is None or not hasattr(response, 'refresh'):
        return
    started = response.timestamp_start
    response.timestamp_start = recorded_at
    try:
        response.refresh()
    finally:
        response.timestamp_start = started


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
        limits = raw.get('limits') if isinstance(raw.get('limits'), dict) else {}
        rules = []
        for entry in (raw.get('rules') or []):
            if not isinstance(entry, dict):
                continue
            try:
                rule = Rule(entry, limits)
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
        sensitive = [str(n).strip().lower() for n in (raw.get('sensitiveHeaders') or []) if str(n).strip()]
        self_targets = [str(n).strip().lower() for n in (raw.get('selfTargets') or []) if str(n).strip()]
        return RuleSet(enabled=enabled, rules=rules, sensitive=sensitive, self_targets=self_targets,
                       limits=limits)


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

        return self.holds_values(self.values(flow))

    def holds_values(self, values):
        """The operator applied to already-resolved values - shared with a match's body tests."""
        values = [v for v in values if v is not None]

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

    def __init__(self, raw, limits=None):
        raw = raw or {}
        self.combine_any = (raw.get('combine') or 'ALL').strip().upper() == 'ANY'
        self.conditions = [Condition(c) for c in (raw.get('conditions') or []) if isinstance(c, dict)]
        self.actions = _prepare_actions(raw.get('actions'), limits)

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

    __slots__ = ('delay_ms', 'terminal', 'mock', 'failure', 'pause', 'applied', 'must_reach_host', 'refresh_from',
                 'sensitive', 'self_targets', 'pre_request', 'pre_response', 'synthetic_response',
                 'original_request', 'original_response', 'final_request', 'final_response')

    def __init__(self):
        self.delay_ms = 0
        self.terminal = None      # 'ABORT_REQUEST' | 'MOCK_RESPONSE' | 'SIMULATE_FAILURE' | None
        self.mock = None          # {'status','headers','body':str} or, for a stored answer, 'body_bytes'
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
        # ANSWER_WITH_RECORDED_CALL with refreshDates: when the answer was recorded (epoch seconds).
        self.refresh_from = None
        # Which header names this call's record must mask - the published list of the ruleset
        # that matched it (see RuleSet.sensitive).
        self.sensitive = frozenset(SENSITIVE_HEADERS)
        # Where REWRITE_URL may never send this call: Alfred itself (see RuleSet.self_targets).
        self.self_targets = frozenset()

    @property
    def touched(self):
        return bool(self.applied)

    def record(self, rule, action, detail=None):
        self.applied.append(Applied(rule.id, rule.name, action, detail))

    def skip(self, rule, action, reason):
        """An action that ran and found nothing to do. Recorded rather than silent: a rule that
        "did nothing" and a rule that never matched look identical in the log otherwise, and the
        first is the one a tester is trying to debug."""
        self.record(rule, action, f'skipped - {reason}')

    def masks(self, name):
        return _sensitive(name, self.sensitive)

    def named(self, name, value=None):
        """A header, cookie or parameter as it may appear in a record: its name, plus its value
        only when the name is not a secret one."""
        if self.masks(name):
            return f'{name} {mask_value(value)}' if value is not None else f'{name} (value not logged)'
        return name if value is None else f'{name}={value}'

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
        # Masked HERE, on the way out, and nowhere earlier - see _masked_snapshot.
        if self.original_request is not None:
            out['originalRequest'] = _masked_snapshot(self.original_request, self.sensitive)
        if self.original_response is not None:
            out['originalResponse'] = _masked_snapshot(self.original_response, self.sensitive)
        if self.final_request is not None:
            out['finalRequest'] = _masked_snapshot(self.final_request, self.sensitive)
        if self.final_response is not None:
            out['finalResponse'] = _masked_snapshot(self.final_response, self.sensitive)
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


def remove_json_field(text, path):
    """Deletes `path` from a JSON document, returning the new text, or None if nothing was removed
    - the same byte-identical contract as set_json_field, and the same path grammar.

    Removing is not setting to null: the key is gone. `segments[*].cabin` removes `cabin` from
    every segment; `items[1]` removes the second element. A trailing `[*]` removes nothing - the
    backend refuses it, since "every element" is an empty array rather than a missing field.
    """
    if not text:
        return None
    try:
        doc = json.loads(text)
    except ValueError:
        return None
    if not _remove(doc, _parse_path(path)):
        return None
    return json.dumps(doc)


def _remove(node, segments):
    if not segments:
        return False
    head, rest = segments[0], segments[1:]
    if head == '*':
        if not isinstance(node, list) or not rest:
            return False
        return any([_remove(item, rest) for item in node])
    if isinstance(head, int):
        if not isinstance(node, list) or head >= len(node) or head < -len(node):
            return False
        if not rest:
            del node[head]
            return True
        return _remove(node[head], rest)
    if not isinstance(node, dict) or head not in node:
        return False
    if not rest:
        del node[head]
        return True
    return _remove(node[head], rest)


def _remove_field_from(message, rule, action, kind, verdict):
    if _unbuffered(message):
        verdict.skip(rule, kind, 'body was streamed, not buffered')
        return
    updated = remove_json_field(message.text, action.get('path'))
    if updated is None:
        verdict.skip(rule, kind, 'path not found')
        return
    message.text = updated
    verdict.record(rule, kind, str(action.get('path')))


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
        # Beside the snapshot, wherever that is - the backend publishes both into one directory.
        self._answers = _AnswerCache(os.path.join(os.path.dirname(os.path.abspath(rules_file or RULES_FILE)), 'answers'))

    def enabled(self):
        return not self._cache.current().inert

    def _matching(self, flow, service_name, ruleset):
        if ruleset.inert:
            return ()
        request = flow.request
        host = (request.pretty_host or request.host or '')
        path = request.path or ''
        out = []
        for rule in ruleset.rules:
            try:
                if rule.match.matches(self.source, service_name, request.method, host, path, request):
                    out.append(rule)
                    if rule.stop_processing:
                        break
            except Exception as e:
                # A rule that throws is skipped, never fatal - proxying must survive a bad rule.
                print(f"[interception] rule {rule.name!r} failed to match, skipping: {e}")
        return out

    async def apply_request(self, flow, service_name=None):
        """Applies every matching rule's request-phase actions, mutating the flow in place.
        Returns a Verdict describing what the addon still has to do.

        Async because a regex find/replace awaits a worker process (see regex_worker.py). Every
        other action is still a synchronous mutation; only the dispatch chain awaits, so an
        action that does not need the event loop costs nothing extra."""
        verdict = Verdict()
        ruleset = self._cache.current()
        verdict.sensitive = ruleset.sensitive
        verdict.self_targets = ruleset.self_targets
        matching = self._matching(flow, service_name, ruleset)
        if matching:
            # Once, up front, for the whole phase - see Verdict.observe_request. A call no rule
            # matches never reaches this line and so never pays for a snapshot.
            verdict.observe_request(flow)
        for rule in matching:
            for action in rule.actions:
                kind = action.get('type')
                if kind not in REQUEST_ACTIONS:
                    if not _known_action(kind):
                        # Recorded once, in the request phase, which every matched call runs.
                        # A newer rules file than this proxy understands must say so in the log.
                        verdict.skip(rule, kind, f'unknown action {kind}')
                    continue
                try:
                    await self._apply_request_action(flow, rule, action, kind, verdict)
                except Exception as e:
                    print(f"[interception] rule {rule.name!r} action {kind} failed, skipping: {e}")
                    continue
                if verdict.terminal:
                    return verdict
                if verdict.pause and verdict.pause['phase'] == 'request':
                    return verdict
        return verdict

    async def _apply_request_action(self, flow, rule, action, kind, verdict):
        request = flow.request

        if kind == 'IF_REQUEST':
            await self._run_conditional(flow, rule, action, kind, verdict, REQUEST_ACTIONS,
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
                verdict.record(rule, kind, verdict.named(name))
            return

        if kind == 'REMOVE_REQUEST_HEADER':
            name = (action.get('name') or '').strip()
            if name and name in request.headers:
                del request.headers[name]
                verdict.record(rule, kind, name)
            elif name:
                verdict.skip(rule, kind, 'no such header')
            return

        if kind == 'SET_REQUEST_TRAILER':
            name = (action.get('name') or '').strip()
            if request.trailers is None:
                verdict.skip(rule, kind, 'no trailers')
            elif name:
                request.trailers[name] = str(action.get('value', ''))
                verdict.record(rule, kind, verdict.named(name))
            return

        if kind == 'REMOVE_REQUEST_TRAILER':
            name = (action.get('name') or '').strip()
            if request.trailers is None:
                verdict.skip(rule, kind, 'no trailers')
            elif name and name in request.trailers:
                del request.trailers[name]
                verdict.record(rule, kind, name)
            elif name:
                verdict.skip(rule, kind, 'no such trailer')
            return

        if kind == 'SET_QUERY_PARAM':
            name = (action.get('name') or '').strip()
            if name:
                value = str(action.get('value', ''))
                request.query[name] = value
                # A query parameter can carry a key as easily as a header can (api_key=...), so
                # the same secret-name list decides whether its value may appear here.
                verdict.record(rule, kind, verdict.named(name, value))
            return

        if kind == 'REMOVE_QUERY_PARAM':
            name = (action.get('name') or '').strip()
            if name and name in request.query:
                del request.query[name]
                verdict.record(rule, kind, name)
            elif name:
                verdict.skip(rule, kind, 'no such parameter')
            return

        if kind == 'SET_REQUEST_JSON_FIELD':
            # .text, never .content: mitmproxy decodes content-encoding for us here, and a
            # gzipped body read as bytes would be corrupted by a naive rewrite.
            updated = set_json_field(request.text, action.get('path'), action.get('value'))
            if updated is not None:
                request.text = updated
                verdict.record(rule, kind, str(action.get('path')))
            else:
                verdict.skip(rule, kind, 'path not found')
            return

        if kind == 'REPLACE_IN_REQUEST_BODY':
            await _replace_in_body(request, rule, action, kind, verdict)
            return

        if kind == 'REWRITE_URL':
            await _rewrite_url(request, rule, action, kind, verdict)
            return

        if kind == 'REMOVE_REQUEST_JSON_FIELD':
            _remove_field_from(request, rule, action, kind, verdict)
            return

        if kind == 'SET_REQUEST_BODY':
            body = action.get('body')
            request.text = '' if body is None else str(body)
            content_type = str(action.get('contentType') or '').strip()
            if content_type:
                request.headers['content-type'] = content_type
            verdict.record(rule, kind, f'{len(request.text)} chars' + (f', {content_type}' if content_type else ''))
            return

        if kind in ('SET_REQUEST_COOKIE', 'REMOVE_REQUEST_COOKIE'):
            _edit_request_cookie(request, rule, action, kind, verdict)
            return

        if kind in ('SET_FORM_FIELD', 'REMOVE_FORM_FIELD'):
            _edit_form_field(request, rule, action, kind, verdict)
            return

        if kind == 'DISABLE_CACHE':
            # Popped by name rather than through mitmproxy's anticache(), so the record can say
            # which of the two the caller actually sent - "nothing to remove" is the answer to
            # "why did I still get a 304" more often than not.
            removed = [name for name in CONDITIONAL_HEADERS if name in request.headers]
            for name in removed:
                del request.headers[name]
            if removed:
                verdict.record(rule, kind, ', '.join(removed))
            else:
                verdict.skip(rule, kind, 'no conditional headers')
            return

        if kind == 'DISABLE_COMPRESSION':
            if (request.headers.get('accept-encoding') or '').strip().lower() == 'identity':
                verdict.skip(rule, kind, 'already identity')
            else:
                request.headers['accept-encoding'] = 'identity'
                verdict.record(rule, kind, 'accept-encoding: identity')
            return

        if kind == 'SET_METHOD':
            method = str(action.get('method') or '').strip().upper()
            if not method.isalpha():
                verdict.skip(rule, kind, 'no method given')
            elif method == (request.method or '').upper():
                verdict.skip(rule, kind, f'already {method}')
            else:
                before = request.method
                request.method = method
                verdict.record(rule, kind, f'{before} → {method}')
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

        if kind == 'ANSWER_WITH_RECORDED_CALL':
            if verdict.must_reach_host:
                verdict.record(rule, kind, 'skipped - an earlier rule requires this call to reach the host')
                return
            loaded, reason = await self._answers.load(action.get('answerId'))
            if loaded is None:
                # The call goes on to the host: a missing answer must not become an invented one.
                verdict.skip(rule, kind, reason)
                return
            meta, body = loaded
            status, headers, body = answer_parts(meta, body, action)
            # Carried out exactly like a mock - the addon builds the response, the log records it
            # as one-sided - with the bytes as stored rather than re-encoded text.
            verdict.terminal = 'MOCK_RESPONSE'
            verdict.mock = {'status': status, 'headers': headers, 'body_bytes': body}
            if action.get('refreshDates') is True:
                verdict.refresh_from = recorded_epoch(meta)
            verdict.record(rule, kind, f'recorded answer {meta.get("id", "")}, {status}, upstream never contacted')
            return

        if kind == 'ANSWER_WITH_FILE':
            if verdict.must_reach_host:
                verdict.record(rule, kind, 'skipped - an earlier rule requires this call to reach the host')
                return
            loaded, reason = await self._answers.load(action.get('answerId'))
            if loaded is None:
                # The call goes on to the host: a missing answer must not become an invented one.
                verdict.skip(rule, kind, reason)
                return
            meta, body = loaded
            status, headers, body = answer_parts(meta, body, action)
            verdict.terminal = 'MOCK_RESPONSE'
            verdict.mock = {'status': status, 'headers': headers, 'body_bytes': body}
            verdict.record(rule, kind, f'uploaded file {meta.get("id", "")}, {status}, upstream never contacted')
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


    async def _run_conditional(self, flow, rule, action, kind, verdict, allowed, apply_one):
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
                await self._run_branch(flow, rule, branch.actions, verdict, allowed, apply_one)
                return

        otherwise = action.get('__otherwise') or []
        if otherwise:
            verdict.record(rule, kind, 'no branch matched - running the else')
            await self._run_branch(flow, rule, otherwise, verdict, allowed, apply_one)
        else:
            verdict.record(rule, kind, 'no branch matched')

    async def _run_branch(self, flow, rule, actions, verdict, allowed, apply_one):
        for nested in actions:
            nested_kind = nested.get('type')
            if nested_kind not in allowed:
                # A response action inside an IF_REQUEST has nothing to act on. The backend
                # refuses to save one; a hand-edited file gets it skipped rather than applied to
                # the wrong half. An action no phase knows is recorded, as at the top level.
                if not _known_action(nested_kind):
                    verdict.skip(rule, nested_kind, f'unknown action {nested_kind}')
                continue
            try:
                await apply_one(flow, rule, nested, nested_kind, verdict)
            except Exception as e:
                print(f"[interception] rule {rule.name!r} action {nested_kind} failed, skipping: {e}")
                continue
            # Same stop conditions as the top-level loop - a terminal or a pause inside a branch
            # ends the phase exactly as it would outside one.
            if verdict.terminal or verdict.pause:
                return

    async def apply_response(self, flow, service_name=None):
        verdict = Verdict()
        if flow.response is None:
            return verdict
        ruleset = self._cache.current()
        verdict.sensitive = ruleset.sensitive
        matching = self._matching(flow, service_name, ruleset)
        if matching:
            verdict.observe_response(flow)
        for rule in matching:
            for action in rule.actions:
                kind = action.get('type')
                if kind not in RESPONSE_ACTIONS:
                    continue
                try:
                    await self._apply_response_action(flow, rule, action, kind, verdict)
                except Exception as e:
                    print(f"[interception] rule {rule.name!r} action {kind} failed, skipping: {e}")
                    continue
                if verdict.pause:
                    return verdict
        return verdict

    async def _apply_response_action(self, flow, rule, action, kind, verdict):
        response = flow.response

        if kind == 'IF_RESPONSE':
            await self._run_conditional(flow, rule, action, kind, verdict, RESPONSE_ACTIONS,
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
                verdict.record(rule, kind, verdict.named(name))
            return

        if kind == 'REMOVE_RESPONSE_HEADER':
            name = (action.get('name') or '').strip()
            if name and name in response.headers:
                del response.headers[name]
                verdict.record(rule, kind, name)
            elif name:
                verdict.skip(rule, kind, 'no such header')
            return

        if kind == 'SET_RESPONSE_TRAILER':
            name = (action.get('name') or '').strip()
            if response.trailers is None:
                verdict.skip(rule, kind, 'no trailers')
            elif name:
                response.trailers[name] = str(action.get('value', ''))
                verdict.record(rule, kind, verdict.named(name))
            return

        if kind == 'REMOVE_RESPONSE_TRAILER':
            name = (action.get('name') or '').strip()
            if response.trailers is None:
                verdict.skip(rule, kind, 'no trailers')
            elif name and name in response.trailers:
                del response.trailers[name]
                verdict.record(rule, kind, name)
            elif name:
                verdict.skip(rule, kind, 'no such trailer')
            return

        if kind == 'SET_RESPONSE_JSON_FIELD':
            updated = set_json_field(response.text, action.get('path'), action.get('value'))
            if updated is not None:
                response.text = updated
                verdict.record(rule, kind, str(action.get('path')))
            else:
                verdict.skip(rule, kind, 'path not found')
            return

        if kind == 'REPLACE_IN_RESPONSE_BODY':
            await _replace_in_body(response, rule, action, kind, verdict)
            return

        if kind == 'REMOVE_RESPONSE_JSON_FIELD':
            _remove_field_from(response, rule, action, kind, verdict)
            return

        if kind in ('SET_RESPONSE_COOKIE', 'REMOVE_RESPONSE_COOKIE'):
            _edit_response_cookie(response, rule, action, kind, verdict)
            return

        if kind == 'SET_RESPONSE_ENCODING':
            encoding = str(action.get('encoding') or '').strip().lower()
            if encoding not in RESPONSE_ENCODINGS:
                verdict.skip(rule, kind, f'unsupported encoding {encoding or "(none)"}')
                return
            current = (response.headers.get('content-encoding') or 'identity').strip().lower()
            if current == encoding:
                verdict.skip(rule, kind, f'already {encoding}')
                return
            # Decode first, always: encode() on a body that is still gzipped would compress the
            # compressed bytes, and the caller would decode once and read garbage.
            response.decode()
            if encoding != 'identity':
                response.encode(encoding)
            verdict.record(rule, kind, f'{current} → {encoding}')
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

        if kind == 'REPLACE_WITH_RECORDED_RESPONSE':
            loaded, reason = await self._answers.load(action.get('answerId'))
            if loaded is None:
                verdict.skip(rule, kind, reason)
                return
            meta, body = loaded
            status, headers, body = answer_parts(meta, body, action)
            set_status(response, status)
            response.headers.clear()
            for name, value in headers.items():
                response.headers[name] = value
            response.content = body
            response.headers['content-length'] = str(len(body))
            if action.get('refreshDates') is True:
                refresh_dates(response, recorded_epoch(meta))
            verdict.record(rule, kind, f'recorded answer {meta.get("id", "")}, {status}, upstream was really called')
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

    def match_for_websocket(self, flow, service_name=None):
        """The rules with at least one MESSAGE action that match this flow - resolved ONCE, at the
        handshake (websocket_start), not per message: a WebSocket connection can carry thousands of
        messages, and re-running every rule's match against the same request for each one would be
        pure waste when the request never changes after the handshake."""
        ruleset = self._cache.current()
        if ruleset.inert:
            return ()
        request = flow.request
        host = (request.pretty_host or request.host or '')
        path = request.path or ''
        out = []
        for rule in ruleset.rules:
            if not any(a.get('type') in MESSAGE_ACTIONS for a in rule.actions):
                continue
            try:
                if rule.match.matches(self.source, service_name, request.method, host, path, request):
                    out.append(rule)
                    if rule.stop_processing:
                        break
            except Exception as e:
                print(f"[interception] rule {rule.name!r} failed to match, skipping: {e}")
        return out

    async def apply_message(self, rules, message, from_client):
        """Applies every MESSAGE action of the given (pre-matched) rules to one WebSocket message,
        in rule order. `rules` is whatever match_for_websocket returned for this connection.

        DROP_MESSAGE is terminal for the message the same way a request-phase terminal is for a
        call: once a message is dropped, no later action has anything left to act on."""
        verdict = MessageVerdict()
        direction = 'client' if from_client else 'server'
        for rule in rules:
            for action in rule.actions:
                kind = action.get('type')
                if kind not in MESSAGE_ACTIONS:
                    if not _known_action(kind):
                        verdict.skip(rule, kind, f'unknown action {kind}')
                    continue
                wants = (action.get('messageDirection') or 'both')
                if wants not in ('both', direction):
                    continue
                if kind == 'DROP_MESSAGE':
                    contains = action.get('contains')
                    if contains and not (message.is_text and contains in message.text):
                        verdict.skip(rule, kind, 'no match')
                        continue
                    verdict.dropped = True
                    verdict.record(rule, kind, 'dropped')
                    return verdict
                if kind == 'DELAY_MESSAGE':
                    ms = _clamp_delay(action.get('durationMs'))
                    if ms:
                        verdict.delay_ms += ms
                        verdict.record(rule, kind, f'{ms} ms')
                    continue
                if kind == 'REPLACE_IN_MESSAGE':
                    if not message.is_text:
                        verdict.skip(rule, kind, 'binary message')
                        continue
                    pattern = action.get('__pattern') or _Pattern(action)
                    new_text, n, reason = await pattern.replace(message.text)
                    if new_text is None:
                        verdict.skip(rule, kind, reason)
                        continue
                    if verdict.original is None:
                        verdict.original = message.text
                    message.text = new_text
                    verdict.edited = new_text
                    verdict.record(rule, kind, f'{n} replacement' + ('' if n == 1 else 's'))
                    continue
        return verdict


class MessageVerdict:
    """What happened to one WebSocket message - the MESSAGE-phase counterpart of Verdict, much
    smaller because a message has no delay-vs-pause distinction, no terminal-vs-mock split, and
    only one "before" to keep (its own original content, not a whole request/response pair)."""

    __slots__ = ('delay_ms', 'dropped', 'edited', 'original', 'applied')

    def __init__(self):
        self.delay_ms = 0
        self.dropped = False
        self.edited = None
        self.original = None
        self.applied = []

    def record(self, rule, action, detail=None):
        self.applied.append(Applied(rule.id, rule.name, action, detail))

    def skip(self, rule, action, reason):
        self.record(rule, action, f'skipped - {reason}')


# Metadata a breakpoint decision leaves on the flow, so the response half of a call can honour
# what was asked for on its request half.
CARD_KEY = 'bp_card'
FOLLOW_KEY = 'bp_follow'
PAUSE_KEY = 'bp_pause'


def note_decision(flow, phase, pause, decision):
    """Records what a human decided, so the rest of this call's cycle can honour it.

    Two separate facts here, and conflating them was tempting and wrong:

      - a CARD exists for this call, so the end of its cycle has to be reported back to the
        backend for the inspector to fill in;
      - the user asked to be stopped AGAIN when the supplier answers.

    A card is left by any decision a person made, because not closing the moment you press Send
    is the whole point. Stopping twice is only what they explicitly ticked. A decision made by a
    clock or a dead connection leaves neither - a rule that pauses everything times out dozens of
    calls on busy traffic, and a card for each would bury the one being worked on.
    """
    decision = decision or {}
    if decision.get('reason'):
        return
    flow.metadata[CARD_KEY] = True
    if phase == 'request' and decision.get('follow') and decision.get('action') != 'abort':
        flow.metadata[FOLLOW_KEY] = True
        flow.metadata[PAUSE_KEY] = dict(pause or {})


def follow_pause(flow):
    """The pause spec for a response the user asked to be stopped at, or None.

    Deliberately not a rule. No rule declared this pause - a person did, at the moment they
    released the request half. Validation forbids one RULE holding both halves because that is a
    static contradiction it cannot reason about; stopping twice in sequence, each time because
    somebody asked for it, is exactly what following a call through its cycle means.
    """
    if not flow.metadata.get(FOLLOW_KEY):
        return None
    spec = dict(flow.metadata.get(PAUSE_KEY) or {})
    spec['phase'] = 'response'
    # Inherited from the request pause, so following a call does not silently give it a different
    # grace period from the rule that stopped it in the first place.
    if not spec.get('timeoutSeconds'):
        spec['timeoutSeconds'] = 30
    if not spec.get('onTimeout'):
        spec['onTimeout'] = 'release'
    return spec


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
