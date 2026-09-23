import { ActionType, ConditionOperator, ConditionSubject, FailureMode } from '../../core/models/interception.model';

/**
 * What every action, subject and operator actually does — as data, not as prose scattered through
 * a template.
 *
 * It is here for two reasons. Prose in a template is prose nobody can test, and this text has to
 * be complete: a guard test walks the action and condition vocabularies and fails if any of them
 * has no entry, so something added later cannot ship undocumented.
 *
 * The bar for `warning` is deliberately high. It is not "here is another fact" - it is the thing
 * that has actually cost somebody an hour, written down so it costs the next person nothing. A
 * warning on every entry would train people to skip all of them.
 */

export interface HelpLine {
  /** The left-hand side: a path, an input, a before. */
  readonly from: string;
  /** What it produces. */
  readonly to: string;
}

export interface HelpEntry {
  readonly title: string;
  /** The wire constant, so what you read here matches what you see in the call log. */
  readonly code: string;
  readonly what: string;
  /** Sets up the example rows - usually the payload they are read against. */
  readonly exampleIntro?: string;
  readonly examples?: readonly HelpLine[];
  /** The one thing that catches people out. Absent when there genuinely isn't one. */
  readonly warning?: string;
}

/** A realistic supplier payload, reused so the examples describe one thing rather than five. */
const SAMPLE_BODY = `{"supplier":"TravelportNdc","searchCriteria":[{"origin":"CAI","destination":"DXB"}],"passengers":[{"count":1}],"promoCodes":null}`;

export const ACTION_HELP: Readonly<Record<ActionType, HelpEntry>> = {
  DELAY_REQUEST: {
    title: 'Delay request',
    code: 'DELAY_REQUEST',
    what: 'Holds the call before it is forwarded, then sends it normally. The caller waits; the host sees nothing unusual.',
    examples: [
      { from: '5000 ms', to: 'the supplier is contacted 5 s late, and still answers' },
      { from: 'two delay actions', to: 'they add up — 5 s + 3 s holds for 8 s' },
    ],
    warning:
      'A delay is not a timeout. The call still succeeds, just late — which is what makes it useful for finding out whether your client HAS a timeout. To make a call fail instead, use Simulate a failure.',
  },
  REMOVE_REQUEST_JSON_FIELD: {
    title: 'Remove request JSON field',
    code: 'REMOVE_REQUEST_JSON_FIELD',
    what: 'Deletes a field from the JSON body before it goes upstream - the key is gone, which a supplier treats differently from the same key set to null.',
    exampleIntro: `Against ${SAMPLE_BODY}:`,
    examples: [
      { from: 'promoCodes', to: 'the body no longer has a promoCodes key at all' },
      { from: 'searchCriteria[*].origin', to: 'origin removed from every search criterion' },
    ],
    warning: 'A path that is not in this body changes nothing, and the log records the action as skipped. A path ending in [*] is refused - remove the array itself instead.',
  },
  SET_REQUEST_BODY: {
    title: 'Replace the request body',
    code: 'SET_REQUEST_BODY',
    what: 'Sends the supplier a completely different body, whatever its content type, with an optional content-type header to match.',
    examples: [
      { from: '<SOAP-ENV:Envelope>...', to: 'a hand-written SOAP request instead of the one the app built' },
      { from: 'empty', to: 'the request goes out with no body at all' },
    ],
    warning: 'Content-Length is corrected for the new body. The method and URL are unchanged - pair it with Set method or Rewrite URL if those need to change too.',
  },
  REWRITE_URL: {
    title: 'Rewrite URL',
    code: 'REWRITE_URL',
    what: 'Sends the call to a different target - another host, port, scheme or path - without redeploying the application that makes it. The caller receives whatever the new target answers.',
    exampleIntro: 'Against https://api.supplier.com/v1/fares?mode=live:',
    examples: [
      { from: 'host staging.supplier.com', to: 'https://staging.supplier.com/v1/fares?mode=live' },
      { from: 'path /v2/fares', to: 'the query string is kept: /v2/fares?mode=live' },
      { from: 'find /v1/ → /v2/', to: 'the pattern form, applied to the whole URL' },
    ],
    warning:
      'The Host header follows the new target unless you keep the original - some hosts route on it. A rewrite that would land on Alfred itself (its backend, gateway or proxy listeners) is refused, because it would loop.',
  },
  SET_METHOD: {
    title: 'Set method',
    code: 'SET_METHOD',
    what: 'Sends the request with a different HTTP method and everything else unchanged - how you find out what a supplier does with a PUT on an endpoint that only documents POST.',
    examples: [
      { from: 'POST → PUT', to: 'same URL, headers and body, method PUT' },
      { from: 'already PUT', to: 'nothing changes, and the log says so' },
    ],
    warning: 'A GET or HEAD normally has no body; changing to one keeps the body the call already had, which some servers reject.',
  },
  REPLACE_IN_REQUEST_BODY: {
    title: 'Find & replace in the request body',
    code: 'REPLACE_IN_REQUEST_BODY',
    what: 'Replaces text anywhere in the body the caller sent before it goes upstream - a token in a SOAP envelope, a date in a form, a code in plain text.',
    exampleIntro: 'Against <PassengerType>ADT</PassengerType>:',
    examples: [
      { from: 'ADT → CHD', to: 'the supplier receives a child passenger' },
      { from: 'no ADT in the body', to: 'nothing changes, and the log says "skipped - no match"' },
    ],
    warning:
      'A body with no match is forwarded byte-for-byte as it arrived - nothing is re-serialised. Regex is opt-in; a regex still running after 2 seconds is stopped and the body is left as it was.',
  },
  SET_REQUEST_HEADER: {
    title: 'Set request header',
    code: 'SET_REQUEST_HEADER',
    what: 'Adds the header, or replaces it when the caller already sent one.',
    examples: [
      { from: 'X-Env: test', to: 'added to a request that had no X-Env' },
      { from: 'x-api-key: wrong', to: 'replaces the key the caller sent, whatever its casing' },
    ],
    warning:
      'Header names are case-insensitive, so setting X-Api-Key replaces an existing x-api-key rather than adding a second one.',
  },
  REMOVE_REQUEST_HEADER: {
    title: 'Remove request header',
    code: 'REMOVE_REQUEST_HEADER',
    what: 'Strips the header before the request is forwarded — how you reproduce a caller that forgot to authenticate.',
    examples: [{ from: 'authorization', to: 'the supplier receives the call with no auth header at all' }],
    warning: 'Removing a header that was never there does nothing and is not an error.',
  },
  SET_QUERY_PARAM: {
    title: 'Set query parameter',
    code: 'SET_QUERY_PARAM',
    what: 'Adds the parameter to the URL, or replaces it when it is already there.',
    exampleIntro: 'For POST /search?page=1',
    examples: [
      { from: 'currency = EGP', to: '/search?page=1&currency=EGP' },
      { from: 'page = 9', to: '/search?page=9' },
    ],
    warning:
      'The URL is the only thing this changes, so the before/after in the call log is the only place you will see it.',
  },
  REMOVE_QUERY_PARAM: {
    title: 'Remove query parameter',
    code: 'REMOVE_QUERY_PARAM',
    what: 'Drops one parameter from the URL and leaves the rest untouched.',
    examples: [{ from: 'debug', to: '/search?page=1&debug=true → /search?page=1' }],
  },
  SET_REQUEST_JSON_FIELD: {
    title: 'Set JSON field in request body',
    code: 'SET_REQUEST_JSON_FIELD',
    what: 'Parses the body as JSON, writes one field, and sends the result. Dotted path, with [0] for an index and [*] for every element.',
    exampleIntro: `For ${SAMPLE_BODY}`,
    examples: [
      { from: 'supplier = "Amadeus"', to: 'the supplier field is rewritten' },
      { from: 'searchCriteria[0].origin = "LHR"', to: 'only the first leg changes' },
      { from: 'searchCriteria[*].origin = "LHR"', to: 'every leg changes' },
      { from: 'missing.field = 1', to: 'nothing happens — see the warning' },
    ],
    warning:
      'It only writes where the path ALREADY exists. That is deliberate: inventing a field the supplier never sends would be testing a payload nobody will ever receive. It also re-serialises the body, so the JSON comes out reformatted.',
  },
  ABORT_REQUEST: {
    title: 'Abort request',
    code: 'ABORT_REQUEST',
    what: 'Kills the connection immediately. Kept for rules that already use it.',
    warning:
      'Superseded by Simulate a failure → Reset the connection, which does exactly this and sits alongside the other five ways a call can break.',
  },
  MOCK_RESPONSE: {
    title: 'Mock response',
    code: 'MOCK_RESPONSE',
    what: 'Answers the caller yourself. The host is never contacted, so the call is absent from the supplier’s logs and does not count against their rate limits.',
    examples: [
      { from: '401 + {"error":"no key"}', to: 'the caller sees exactly that, in under a millisecond' },
      { from: 'compare with', to: 'Reply with a different response, where the host IS really called' },
    ],
    warning:
      'It ends the request phase: nothing after it runs, and no response-half action can fire because there is no response to work on.',
  },
  SIMULATE_FAILURE: {
    title: 'Simulate a failure',
    code: 'SIMULATE_FAILURE',
    what: 'Everything a supplier does that is not a status code — resets, hangs, empty and truncated replies. Pick which one from the dropdown; each is explained on the card.',
    examples: [
      { from: 'Reset the connection', to: 'the caller gets an EOF, not an HTTP response' },
      { from: 'Hang, then drop', to: 'a supplier that goes quiet — your read timeout is what fires' },
      { from: 'Truncated body', to: 'part of the body arrives, then the socket closes short' },
    ],
    warning:
      'DNS and TLS failures are not offered, because they cannot be reproduced: your client is connected to Alfred, and that handshake already succeeded before any rule ran.',
  },
  PAUSE_REQUEST: {
    title: 'Pause and wait for me (before forwarding)',
    code: 'PAUSE_REQUEST',
    what: 'Holds the call on the Interception page so you can read it, edit it, and then release or abort it by hand. The caller’s connection stays open the whole time.',
    examples: [
      { from: 'timeout 30 s', to: 'grace period for you to NOTICE it, not to decide' },
      { from: 'Take control', to: 'stops the clock — editing anything does this automatically' },
      { from: 'on timeout', to: 'release unchanged, or abort, if nobody is watching' },
    ],
    warning:
      'Every paused call is a real client socket held open. Do not leave a pause rule enabled on traffic you are not watching.',
  },
  SEND_TO_HOST: {
    title: 'Send the call to the host',
    code: 'SEND_TO_HOST',
    what: 'States that this call must really be forwarded. Forwarding is already the default, so on its own it documents intent — what makes it more is that it latches.',
    examples: [
      { from: 'this rule, priority 10', to: 'send to host' },
      { from: 'a broad rule, priority 100', to: 'mock everything — refused for this call' },
    ],
    warning:
      'Once it has run, a MOCK_RESPONSE, SIMULATE_FAILURE or ABORT_REQUEST from any LATER rule is refused and recorded as skipped. That is how you carve one exception out of a broad mocking rule without editing the broad rule.',
  },
  IF_REQUEST: {
    title: 'Condition — look at the request, then decide',
    code: 'IF_REQUEST',
    what: 'Branches, tried in order. The first whose conditions hold runs its actions, and nothing after it runs. An ELSE covers the rest.',
    examples: [
      { from: 'IF no x-api-key', to: 'mock a 401' },
      { from: 'ELSE IF x-api-key = test-key', to: 'delay 8 s and carry on' },
      { from: 'ELSE', to: 'send it to the host' },
    ],
    warning:
      'Two branches may each end the call — they are alternatives, never a sequence, so only one ever runs. Conditions nest two levels deep at most.',
  },
  DELAY_RESPONSE: {
    title: 'Delay response',
    code: 'DELAY_RESPONSE',
    what: 'The host answers normally, then Alfred holds the reply before passing it on. The supplier’s own timing in the log is unaffected; the caller just waits longer.',
    examples: [{ from: '3000 ms', to: 'a 200 ms supplier call arrives at the caller 3.2 s in' }],
    warning: 'Capped at 120 s, and like a request delay it is not a timeout — the call still succeeds.',
  },
  SET_RESPONSE_STATUS: {
    title: 'Set response status',
    code: 'SET_RESPONSE_STATUS',
    what: 'Changes the status code the caller sees, leaving the body and headers as the host sent them.',
    examples: [{ from: '200 → 503', to: 'the real body is still delivered, under a 503' }],
    warning:
      'The reason phrase is set to match, so you never get "503 Temporary Redirect" — a number saying one thing and the text beside it another.',
  },
  SET_RESPONSE_HEADER: {
    title: 'Set response header',
    code: 'SET_RESPONSE_HEADER',
    what: 'Adds a header to the reply, or replaces one the host sent.',
    examples: [
      { from: 'cache-control: no-store', to: 'added to the response' },
      { from: 'content-type: text/plain', to: 'replaces what the supplier declared' },
    ],
  },
  REMOVE_RESPONSE_HEADER: {
    title: 'Remove response header',
    code: 'REMOVE_RESPONSE_HEADER',
    what: 'Strips a header before the caller sees it — how you find out what your client does without one.',
    examples: [{ from: 'content-type', to: 'the caller must guess how to parse the body' }],
  },
  SET_RESPONSE_JSON_FIELD: {
    title: 'Set JSON field in response body',
    code: 'SET_RESPONSE_JSON_FIELD',
    what: 'Parses the reply as JSON and rewrites one field. Same path syntax as the request side.',
    exampleIntro: 'For {"offers":[{"price":412.5},{"price":380}],"currency":"EGP"}',
    examples: [
      { from: 'currency = "USD"', to: 'one field changes, everything else is kept' },
      { from: 'offers[*].price = 0', to: 'every offer becomes free' },
    ],
    warning: 'Writes only where the path exists, and reformats the body — same as the request-side version.',
  },
  SET_RESPONSE_BODY: {
    title: 'Replace the response body',
    code: 'SET_RESPONSE_BODY',
    what: 'Swaps the whole body, whatever its content type. The escape hatch for a payload that is not JSON, or a change too structural for a field path.',
    examples: [
      { from: '{"offers":[]}', to: 'an empty result set' },
      { from: 'a SOAP fault', to: 'for a supplier that does not speak JSON' },
      { from: 'empty', to: 'blank the body entirely' },
    ],
    warning: 'The status and headers are untouched, so a 200 with content-length from the real reply still says 200.',
  },
  REMOVE_RESPONSE_JSON_FIELD: {
    title: 'Remove response JSON field',
    code: 'REMOVE_RESPONSE_JSON_FIELD',
    what: 'Deletes a field from the JSON the supplier sent before the caller sees it - how you prove the application copes with a field that is MISSING, which is not the same as one that is null.',
    exampleIntro: 'Against {"itinerary":{"seatsRemaining":4},"segments":[{"cabin":"Y"},{"cabin":"J"}]}:',
    examples: [
      { from: 'itinerary.seatsRemaining', to: '{"itinerary":{}} - the key is absent' },
      { from: 'segments[*].cabin', to: 'cabin removed from every segment' },
      { from: 'segments[1]', to: 'the second segment removed from the array' },
    ],
    warning: 'The body is re-serialised only when something was actually removed; otherwise it reaches the caller byte-for-byte as the supplier sent it.',
  },
  REPLACE_IN_RESPONSE_BODY: {
    title: 'Find & replace in the response body',
    code: 'REPLACE_IN_RESPONSE_BODY',
    what: 'Replaces text anywhere in the response body, whatever its content type - the edit a SOAP, XML or plain-text supplier payload needs, which no JSON field path can reach.',
    exampleIntro: 'Against <Fare><Currency>EUR</Currency><Amount>412.50</Amount></Fare>:',
    examples: [
      { from: 'EUR → USD', to: 'every EUR in the body becomes USD' },
      { from: 'EUR → USD, at most 1', to: 'only the first one changes' },
      { from: 'regex <Amount>(\\d+)\\.\\d+</Amount> → <Amount>\\1.00</Amount>', to: '412.50 becomes 412.00' },
    ],
    warning:
      'Literal by default: $, . and ( match themselves. Switch on Regex for a pattern, and keep it simple - one that is still running after 2 seconds is stopped, and the body goes through unchanged. A compressed body is decoded first and re-compressed after, so gzip is fine.',
  },
  REPLACE_RESPONSE: {
    title: 'Reply with a different response',
    code: 'REPLACE_RESPONSE',
    what: 'The host IS really called, logged and timed — only what the caller receives is swapped. Leave a field empty to keep what the host sent.',
    examples: [
      { from: 'status only', to: 'the real body arrives under your status' },
      { from: 'body only', to: 'the real status, your payload' },
      { from: 'compare with', to: 'Mock response, which never opens a connection at all' },
    ],
    warning:
      'It runs in the response half, so it never fires on a call an earlier action mocked, failed or aborted — there is no response to replace.',
  },
  PAUSE_RESPONSE: {
    title: 'Pause and wait for me (after the supplier answers)',
    code: 'PAUSE_RESPONSE',
    what: 'Holds the real reply so you can read it, change the status, headers or body, and then release it — or abort the connection.',
    examples: [
      { from: 'the host answers 200', to: 'you release it as a 500 with your body' },
      { from: 'both are kept', to: 'the log records what upstream sent AND what the caller got' },
    ],
    warning: 'Like any pause, the caller’s socket is held open until you decide or the timeout fires.',
  },
  IF_RESPONSE: {
    title: 'Condition — look at the response, then decide',
    code: 'IF_RESPONSE',
    what: 'The same branching as on the request side, evaluated once the host has answered — so it can read the status, headers and body it sent back.',
    examples: [
      { from: 'IF status ≥ 500', to: 'hand the caller an empty 200 instead' },
      { from: 'IF body contains RATE_LIMIT', to: 'replace it with something your client handles' },
      { from: 'and request header x-env = test', to: 'response conditions can read the request too' },
    ],
    warning:
      'It never runs on a call that was mocked, failed or aborted in the request half — nothing came back to look at.',
  },
};

export const SUBJECT_HELP: Readonly<Record<ConditionSubject, HelpEntry>> = {
  REQUEST_HEADER: {
    title: 'Request header',
    code: 'REQUEST_HEADER',
    what: 'One header the caller sent. Names are matched case-insensitively, as HTTP does.',
    examples: [
      { from: 'x-api-key', to: 'finds X-Api-Key, X-API-KEY, x-api-key' },
      { from: 'a header sent as ""', to: 'EXISTS is true — empty is not missing' },
    ],
    warning:
      'Header VALUES are compared case-insensitively too unless you tick Aa, because supplier casing is not yours to predict.',
  },
  REQUEST_BODY: {
    title: 'Request body',
    code: 'REQUEST_BODY',
    what: 'The whole body as raw text, exactly as it crossed the wire. For non-JSON payloads — SOAP, form-encoded — or a substring you know is really there.',
    exampleIntro: 'A Java client sends this, compact:',
    examples: [
      { from: SAMPLE_BODY, to: 'contains "supplier":"TravelportNdc" → matches' },
      { from: 'the same body', to: 'contains "supplier": "TravelportNdc" → does NOT match' },
    ],
    warning:
      'Whitespace matters, and an export PRETTY-PRINTS the body. Copying `"supplier": "X"` out of an export will not be found on the wire, where there is no space after the colon. For anything structural, use Request JSON field instead — it parses, so formatting is irrelevant.',
  },
  REQUEST_JSON_FIELD: {
    title: 'Request JSON field',
    code: 'REQUEST_JSON_FIELD',
    what: 'Parses the request body as JSON and reads one field. Whitespace, key order and formatting do not matter. Dotted path, [0] for an index, [*] for every element.',
    exampleIntro: `For ${SAMPLE_BODY}`,
    examples: [
      { from: 'supplier', to: '"TravelportNdc"' },
      { from: 'searchCriteria[0].origin', to: '"CAI"' },
      { from: 'searchCriteria[*].destination', to: 'every leg — holds if ANY of them matches' },
      { from: 'promoCodes', to: 'null, which EXISTS — use equals null to test for it' },
      { from: 'missing.field', to: 'nothing, so "does not exist" is true' },
    ],
    warning:
      'A body that is not JSON — or is not valid JSON — makes every field condition behave as absent rather than as an error. Nothing throws, and nothing matches.',
  },
  QUERY_PARAM: {
    title: 'Query parameter',
    code: 'QUERY_PARAM',
    what: 'One parameter from the URL’s query string.',
    exampleIntro: 'For /search?currency=USD&page=1&debug=',
    examples: [
      { from: 'currency', to: '"USD"' },
      { from: 'debug', to: '"" — present, so EXISTS is true' },
      { from: 'sort', to: 'nothing, so "does not exist" is true' },
    ],
    warning: '?debug= exists with an empty value. Missing and empty are different things here.',
  },
  URL: {
    title: 'URL',
    code: 'URL',
    what: 'The full URL including the query string, as the caller asked for it.',
    examples: [
      { from: 'contains /v4/order', to: 'matches a path segment' },
      { from: 'matches regex /v\\d+/order', to: 'matches v3, v4, v5…' },
    ],
    warning: 'The query string is part of it, so "ends with /search" fails on /search?page=1.',
  },
  METHOD: {
    title: 'Method',
    code: 'METHOD',
    what: 'The HTTP verb. Compared case-insensitively, so post and POST are the same.',
    examples: [{ from: 'equals POST', to: 'matches POST requests only' }],
    warning:
      'The rule’s own Methods field above does the same job for the whole rule. Use this one only when a single branch needs to differ.',
  },
  RESPONSE_STATUS: {
    title: 'Response status',
    code: 'RESPONSE_STATUS',
    what: 'The status code the host answered with, as a number.',
    examples: [
      { from: 'is at least 500', to: 'every server error' },
      { from: 'equals 429', to: 'rate limited, exactly' },
    ],
    warning: 'Available in the response half only — in the request half nothing has answered yet.',
  },
  RESPONSE_HEADER: {
    title: 'Response header',
    code: 'RESPONSE_HEADER',
    what: 'One header the host sent back. Case-insensitive, like the request side.',
    examples: [
      { from: 'content-type contains json', to: 'the supplier claims to be returning JSON' },
      { from: 'retry-after exists', to: 'the supplier is asking you to back off' },
    ],
  },
  RESPONSE_BODY: {
    title: 'Response body',
    code: 'RESPONSE_BODY',
    what: 'The whole reply as raw text. Useful for a supplier that signals errors inside a 200.',
    examples: [
      { from: 'contains RATE_LIMIT', to: 'a 200 that is really a failure' },
      { from: 'contains <soap:Fault', to: 'for a supplier that does not speak JSON' },
    ],
    warning: 'Raw text, so the same whitespace trap applies as on the request side. Prefer Response JSON field.',
  },
  RESPONSE_JSON_FIELD: {
    title: 'Response JSON field',
    code: 'RESPONSE_JSON_FIELD',
    what: 'Parses the reply as JSON and reads one field. Same path syntax as everywhere else.',
    exampleIntro: 'For {"offers":[],"status":"NO_AVAILABILITY"}',
    examples: [
      { from: 'status', to: '"NO_AVAILABILITY"' },
      { from: 'offers[*].price', to: 'every price — holds if ANY matches' },
    ],
    warning: 'Available in the response half only.',
  },
};

export const OPERATOR_HELP: Readonly<Record<ConditionOperator, HelpEntry>> = {
  EXISTS: {
    title: 'exists',
    code: 'EXISTS',
    what: 'The header, parameter or field is present at all — whatever its value.',
    examples: [
      { from: 'a header sent as ""', to: 'true — empty is still present' },
      { from: 'a JSON field set to null', to: 'true — null is a value' },
    ],
  },
  NOT_EXISTS: {
    title: 'does not exist',
    code: 'NOT_EXISTS',
    what: 'Nothing is there. The direct way to test for something missing.',
    examples: [{ from: 'no x-api-key header at all', to: 'true' }],
    warning:
      'Say it this way rather than with a negative comparison. "does not equal" is ALSO true when the thing is missing, which is rarely what you mean.',
  },
  EQUALS: {
    title: 'equals',
    code: 'EQUALS',
    what: 'The whole value, not a part of it. Case-insensitive unless you tick Aa.',
    examples: [
      { from: 'EGY vs egy', to: 'equal, unless Aa is ticked' },
      { from: 'a [*] path', to: 'holds if ANY element equals it' },
    ],
  },
  NOT_EQUALS: {
    title: 'does not equal',
    code: 'NOT_EQUALS',
    what: 'Anything other than that exact value, compared case-insensitively unless you tick Aa.',
    examples: [
      { from: 'a header that was never sent', to: 'TRUE — see the warning' },
      { from: 'a [*] path', to: 'true only when NO element equals it' },
    ],
    warning:
      'An absent subject is not equal to anything, so this is true for a header that was never sent. If you mean "present and different", add a second condition with exists.',
  },
  CONTAINS: {
    title: 'contains',
    code: 'CONTAINS',
    what: 'The value contains this text anywhere inside it. A substring, not a word.',
    examples: [
      { from: 'Java in Java/1.8.0_191', to: 'true' },
      { from: 'cat in certificate', to: 'true — it is not word-aware' },
    ],
  },
  NOT_CONTAINS: {
    title: 'does not contain',
    code: 'NOT_CONTAINS',
    what: 'The text appears nowhere in the value - the opposite of contains, and a substring test either way.',
    examples: [{ from: 'an absent subject', to: 'TRUE — nothing contains anything' }],
    warning: 'Same absent-subject rule as "does not equal": missing satisfies it.',
  },
  MATCHES: {
    title: 'matches regex',
    code: 'MATCHES',
    what: 'A regular expression, SEARCHED for anywhere in the value — anchor it with ^ and $ if you mean the whole thing.',
    examples: [
      { from: '^v\\d+\\.\\d+', to: 'matches v4.2.1' },
      { from: '\\d{3}', to: 'matches anywhere three digits appear' },
    ],
    warning:
      'Compiled once when the rule is saved, so a pattern that does not compile is refused there rather than silently never firing.',
  },
  NOT_MATCHES: {
    title: 'does not match regex',
    code: 'NOT_MATCHES',
    what: 'The pattern is found nowhere in the value.',
    examples: [{ from: 'an absent subject', to: 'TRUE — nothing matches anything' }],
    warning: 'Same absent-subject rule as the other negatives.',
  },
  AT_LEAST: {
    title: 'is at least',
    code: 'AT_LEAST',
    what: 'Numeric comparison, ≥. For a status, or for a number inside a body.',
    examples: [
      { from: 'status is at least 500', to: 'every server error' },
      { from: 'passengers[*].count is at least 5', to: 'a group booking' },
    ],
    warning: 'A value that is not a number simply fails the test — it is never an error, and never "smaller".',
  },
  AT_MOST: {
    title: 'is at most',
    code: 'AT_MOST',
    what: 'Numeric comparison, ≤. The subject is read as a number, so it works on a status or on any number inside a body.',
    examples: [
      { from: 'passengers[*].age is at most 17', to: 'any minor in the booking' },
      { from: 'offers[*].price is at most 0', to: 'a free or negative fare' },
    ],
    warning: 'Same as "is at least": a non-numeric value fails rather than erroring.',
  },
};

/** The six ways Simulate a failure can break a call, for the help on that card. */
export const FAILURE_HELP: Readonly<Record<FailureMode, string>> = {
  CONNECTION_RESET: 'Killed before forwarding — the caller gets a reset or EOF, never an HTTP response.',
  HANG_THEN_DROP: 'Held for as long as you say, then dropped. Your client’s read timeout is what finally fires.',
  HANG_UNTIL_CALLER_GIVES_UP: 'Held until the client gives up on its own — which tests whether it has a timeout at all.',
  EMPTY_REPLY: 'A valid 200 with zero bytes. Parses as HTTP and breaks anything assuming a body.',
  TRUNCATED_BODY: 'Part of the body arrives, then the socket closes short of the length it promised.',
  GATEWAY_ERROR: 'A 502/503/504 from an intermediary, without the host being contacted.',
};

export function helpForAction(type: ActionType): HelpEntry {
  return ACTION_HELP[type];
}

export function helpForSubject(subject: ConditionSubject): HelpEntry {
  return SUBJECT_HELP[subject];
}

export function helpForOperator(operator: ConditionOperator): HelpEntry {
  return OPERATOR_HELP[operator];
}
