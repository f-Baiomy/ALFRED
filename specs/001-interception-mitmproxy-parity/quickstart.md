# Quickstart: verifying the feature

These checks are the live-verification steps from the spec. Record each measured result in
`docs/interception.md`, in the style of the claims already there ("measured: …").

## Build and test

```bash
cd proxy && python -m unittest discover -s . -p "test_*.py" -v
cd backend && mvn test
cd frontend && npx ng test --watch=false --browsers=ChromeHeadless && npm run build
docker compose up -d --build backend proxy reverse-proxy frontend && docker compose restart app-gateway
```

The proxy modules are imported once, so a restart is required after changing `interception.py`.
If `mvn -version` is not JDK 21, run Maven in Docker as `CLAUDE.md` describes.

## Live checks (outbound through `127.0.0.2:443`, inbound through a project `listenPort`)

1. **Literal replace on gzip (US1)**:
   - Add a rule `REPLACE_IN_RESPONSE_BODY` with the literal `EUR` → `USD`.
   - Run `curl --compressed` against a gzip JSON endpoint.
   - Expect: the output decodes, all occurrences are replaced, and the card shows the
     before/after.
2. **Regex timeout (US1, SC-003)**:
   - Add a regex rule that passes the save-time checks but is slow on a crafted 5 MB body.
   - Send that call together with 4 other concurrent calls.
   - Expect: the slow call is recorded as `skipped - pattern timed out`, and the 4 others
     finish at their normal latency.
3. **Rewrite URL (US2)**:
   - Rewrite `api.supplier.test` to a second reachable host.
   - Expect: the log shows both targets and the `Host` header follows the new target.
   - A rule targeting `localhost:5000` is refused at save time.
   - A regex that produces `backend:5000` is refused at run time and recorded as `refused`.
4. **Remove JSON field (US3)**: `REMOVE_RESPONSE_JSON_FIELD segments[*].cabin`. Expect: the key
   is absent from every segment, not null.
5. **Cookies (US4)**: remove `consent` from `Cookie: session=a; consent=b; theme=c`. Expect: the
   upstream receives `session=a; theme=c` byte-for-byte, and the interception record shows
   `(value not logged …)`.
6. **Encoding (US5)**: `SET_RESPONSE_ENCODING br` on a plain response. Expect:
   `curl --compressed` decodes it and `content-encoding: br` is present.
7. **Recorded answer (US6, SC-004)**:
   - Pick an **inbound** call and save `ANSWER_WITH_RECORDED_CALL`.
   - When a `set-cookie` is present, the save first prompts keep/strip.
   - Stop the upstream.
   - Expect: the caller gets the recorded response in the same latency class as
     `MOCK_RESPONSE` (about 10 ms). Deleting the original call does not break the rule.
8. **File answer (US7)**:
   - Upload a 5 MB fixture: served byte-exact.
   - Upload a 10 MB + 1 byte file: `413`, with the limit stated.
9. **Resend (US8, SC-008)**:
   - Resend an outbound call. Expect: a new card marked "↻ resend of …", with rules applied.
   - Resend an inbound call with a header edited. Expect: the edits are listed.
   - Use "resend with current session" on a cycle call whose cookie has expired. Expect: the
     name and source call are shown, and the value stays masked.
10. **WebSocket (US9, SC-009)**:
    - Open a WebSocket through the proxy and send 100 messages per second for 20 s.
    - Expect: every message up to the cap (1,000) is logged in order, and `dropped` counts the
      rest.
    - A `DELAY_MESSAGE 2000` rule delays only that connection.
11. **Trailers (US10)**: use an HTTP/2 or gRPC echo endpoint. Expect: removing `grpc-status`
    removes it.
12. **Matchers (US11)**: add rule A (host + `x-test` EXISTS, stopProcessing) and rule B (host).
    Expect: a call without `x-test` gets rule B.
13. **No-rule overhead (SC-002)**: 200 calls with interception on and no rule matching, measured
    before and after. Expect: no measurable difference in the p50 or p95 of `duration_ms`.
