"""Streams between Alfreds (specs/035), end to end: three linked backends on one Docker network - a (the host, PC-1),
b (STG 83, owns a cycle and is an environment of a's board) and c (Ninety, reads b's cycle through a's board).
Started by tests/e2e/run_streams_e2e.sh; the ports come from STREAMS_E2E_PORTS (default 15101,15102,15103)."""
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import os

_PORTS = os.environ.get("STREAMS_E2E_PORTS", "15101,15102,15103").split(",")
A, B, C = ("http://localhost:" + p for p in _PORTS)
# the addresses a dials to reach b and c on their Docker network
B_ADDR, C_ADDR = os.environ.get("STREAMS_E2E_HOSTS", "alfred-streams-b:5000,alfred-streams-c:5000").split(",")
SECRET = "test-secret"
CRLF = chr(13) + chr(10)


def call(method, url, body=None, headers=None, raw=False):
    data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
            return r.status, (text if raw else (json.loads(text) if text else None)), dict(r.headers)
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text), dict(e.headers)
        except Exception:
            return e.code, text.decode(errors="replace"), dict(e.headers)


def ok(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        global failures
        failures += 1


failures = 0


def find_all(node, key):
    """Every value of `key` anywhere in a JSON answer, in order."""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key and not isinstance(v, (dict, list)):
                out.append(v)
            out.extend(find_all(v, key))
    elif isinstance(node, list):
        for v in node:
            out.extend(find_all(v, key))
    return out


def link(frm, to_addr, to, name_here, name_there):
    s, links, _ = call("GET", frm + "/links")
    for l in links:
        if l["name"] == name_here:
            return
    s, p, _ = call("POST", frm + "/links/pair", {"address": to_addr, "name": name_here})
    assert s == 200, p
    s, offers, _ = call("GET", to + "/links/pair/offers")
    oid = [o for o in offers if o["code"] == p["code"]][0]["id"]
    s, _, _ = call("POST", to + "/links/pair/offers/" + oid + "/accept", {"name": name_there})
    for _ in range(20):
        s, ps, _ = call("GET", frm + "/links/pairings")
        if any(x["id"] == p["id"] and x["state"] == "LINKED" for x in ps):
            break
        time.sleep(0.5)
    time.sleep(1.5)


def link_of(base, name):
    s, links, _ = call("GET", base + "/links")
    return [l for l in links if l["name"] == name][0]


def post_call(base, project, path, status=200, body='{"ok":true}', token="Bearer secret-123"):
    cid = str(uuid.uuid4())
    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    s, _, _ = call("POST", base + "/internal-calls/webhook/prepare", {
        "id": cid, "original_url": "http://app" + path, "url": "http://app" + path, "method": "GET",
        "request": {"headers": {"Authorization": token, "X-Request-Id": "r-" + cid[:4]}, "body": None},
        "timestamp": now, "service_name": project}, {"X-Webhook-Secret": SECRET})
    assert s in (200, 204), s
    s, _, _ = call("POST", base + "/internal-calls/webhook/" + cid + "/complete", {
        "response": {"status": status, "headers": {"Content-Type": "application/json", "Set-Cookie": "sid=abc"}, "body": body},
        "duration_ms": 12.5, "call": {"original_url": "http://app" + path, "url": "http://app" + path, "method": "GET",
                                      "timestamp": now, "service_name": project}}, {"X-Webhook-Secret": SECRET})
    assert s in (200, 204), s
    return cid


def main():
    link(A, B_ADDR, B, "STG 83", "PC-1")
    link(A, C_ADDR, C, "Ninety", "PC-1")
    a_b = link_of(A, "STG 83")
    b_a = link_of(B, "PC-1")
    ok(a_b["online"] and b_a["online"], "a and b linked and online")

    # a recording cycle on b, three calls
    s, cyc, _ = call("POST", B + "/session-cycles", {"name": "regression run 2", "assignedTo": "odeysys"})
    cycle = cyc["id"]
    call("POST", B + "/session-cycles/" + cycle + "/record")
    ids = [post_call(B, "odeysys", "/odeysys/refunds?branch=BRN11"), post_call(B, "odeysys", "/odeysys/refunds/7", 500),
           post_call(B, "odeysys", "/odeysys/agency?x=1")]
    time.sleep(2)
    s, calls, _ = call("GET", B + "/session-cycles/" + cycle + "/internal-calls")
    n_calls = len(calls if isinstance(calls, list) else calls.get("calls", calls.get("items", [])))
    ok(n_calls == 3, "b captured 3 calls (%s)" % n_calls)
    # what the agent caught during the failing call: two statements (one reads a masked column) and an ERROR line
    s, red, _ = call("POST", B + "/redactions", {"scope": "all", "kind": "db-column", "name": "card_number"})
    ok(s == 200, "b masks the card_number column (%s %s)" % (s, red))
    s, _, _ = call("POST", B + "/db-capture/agent/batch", {
        "agentId": "agent-b", "project": "odeysys",
        "markers": [{"callId": ids[1], "seq": 0, "type": "CALL_OPEN", "redis": True}],
        "redis": [{"sid": "agent-b:r1", "callId": ids[1], "seq": 4, "command": "GET", "keys": ["refund:7:fee"],
                   "args": base64.b64encode("*2|$3|GET|$12|refund:7:fee|".replace("|", CRLF).encode()).decode(),
                   "reply": base64.b64encode("$-1|".replace("|", CRLF).encode()).decode(), "replyType": "NIL"}],
        "statements": [
            {"sid": "agent-b:1", "callId": ids[1], "thread": "task-1", "seq": 1, "kind": "SELECT",
             "sql": "SELECT id, total, card_number FROM refund WHERE id = ?", "params": [[{"type": "BIGINT", "value": "7"}]],
             "outcome": {"kind": "ROWS", "columns": [{"name": "id", "type": "BIGINT"}, {"name": "total", "type": "DECIMAL"},
                                                      {"name": "card_number", "type": "VARCHAR"}], "rowsRead": 1},
             "rows": [[{"type": "BIGINT", "value": "7"}, {"type": "DECIMAL", "value": "120.50"},
                       {"type": "VARCHAR", "value": "4111111111111111"}]], "durationMicros": 900},
            {"sid": "agent-b:2", "callId": ids[1], "thread": "task-1", "seq": 2, "kind": "UPDATE",
             "sql": "UPDATE refund SET state = ? WHERE id = ?", "params": [[{"type": "VARCHAR", "value": "APPROVED"},
                                                                           {"type": "BIGINT", "value": "7"}]],
             "outcome": {"kind": "UPDATED", "affected": 0}, "durationMicros": 400}],
        "logs": [{"callId": ids[1], "seq": 3, "at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "level": "ERROR",
                  "logger": "com.odeysys.refund.RefundService", "thread": "task-1", "message": "Refund 7 approve failed",
                  "exceptionType": "java.lang.NullPointerException", "exceptionMessage": "fee is null",
                  "exceptionStack": "java.lang.NullPointerException: fee is null\n\tat com.odeysys.refund.RefundService.approve(RefundService.java:88)"}]},
        {"X-Webhook-Secret": SECRET})
    ok(s in (200, 202), "b stored the call's statements and log line (%s)" % s)
    time.sleep(1.5)
    s, own, _ = call("GET", B + "/db-capture/calls/" + ids[1] + "/statements")
    select_id = [x["id"] for x in own.get("statements", []) if x.get("kind") == "SELECT"] if s == 200 else []
    s, own_rows, _ = call("GET", B + "/db-capture/statements/%s/rows" % (select_id[0] if select_id else 0))
    ok(s == 200 and "4111111111111111" in json.dumps(own_rows), "b itself shows the column (%s)" % s)

    # not streamed yet: a cannot read it
    s, body, _ = call("GET", A + "/session-cycles/" + cycle + "@" + a_b["slug"])
    ok(s == 403 and body.get("error") == "NOT_STREAMED", "not streamed -> 403 NOT_STREAMED (%s %s)" % (s, body))

    # b streams the cycle to a
    s, st, _ = call("POST", B + "/links/streams", {"linkId": b_a["id"], "kind": "CYCLE", "target": cycle, "targetName": "regression run 2",
                                                    "project": "odeysys", "mode": "COMMENT"})
    ok(s == 200, "stream started")
    time.sleep(1.5)
    s, mirrors, _ = call("GET", A + "/links/streams?mine=false")
    ok(any(m["target"] == cycle for m in mirrors), "a has the stream's copy")

    ref = cycle + "@" + a_b["slug"]
    s, c1, h = call("GET", A + "/session-cycles/" + urllib.parse.quote(ref, safe=""))
    ok(s == 200 and c1.get("id") == ref, "cycle read by ref, id tagged (%s %s)" % (s, c1.get("id") if isinstance(c1, dict) else c1))
    s, cc, _ = call("GET", A + "/session-cycles/" + ref + "/internal-calls")
    items = cc if isinstance(cc, list) else cc.get("calls", cc.get("items", []))
    ok(len(items) == 3, "cycle calls relayed (%d)" % len(items))
    text = json.dumps(cc)
    ok("secret-123" not in text, "Authorization masked at the source")
    some = ids[1]
    s, d, _ = call("GET", A + "/internal-calls/" + some + "@" + a_b["slug"] + "/detail")
    ok(s == 200, "call detail relayed (%s)" % s)
    ok("secret-123" not in json.dumps(d) and "sid=abc" not in json.dumps(d), "detail masked (Authorization, Set-Cookie)")
    ok('"r-' in json.dumps(d), "other headers kept")
    # its statements and its log line, read on a through the link - the masked column masked at the source
    s, st_a, _ = call("GET", A + "/db-capture/calls/" + some + "@" + a_b["slug"] + "/statements")
    text_st = json.dumps(st_a)
    ok(s == 200 and "UPDATE refund SET state" in text_st and "SELECT id, total, card_number" in text_st,
       "statements relayed (%s %s)" % (s, text_st[:200]))
    s, rows_a, _ = call("GET", A + "/db-capture/statements/%s@%s/rows" % (select_id[0] if select_id else 0, a_b["slug"]))
    text_rows = json.dumps(rows_a)
    ok(s == 200 and "4111111111111111" not in text_rows and "***REDACTED***" in text_rows and "120.50" in text_rows,
       "rows relayed with card_number masked at the source, other columns kept (%s %s)" % (s, text_rows[:300]))
    ok("4111111111111111" not in text_st, "no card number in the statements either")
    s, logs_a, _ = call("GET", A + "/call-logs/" + some + "@" + a_b["slug"])
    text_lg = json.dumps(logs_a)
    ok(s == 200 and "Refund 7 approve failed" in text_lg and "RefundService.java:88" in text_lg,
       "caught log line relayed with its stack (%s %s)" % (s, text_lg[:200]))
    s, rcmds, _ = call("GET", A + "/db-capture/calls/" + some + "@" + a_b["slug"] + "/store-commands")
    cmd_ids = find_all(rcmds, "id")
    ok(s == 200 and "refund:7:fee" in json.dumps(rcmds), "Redis commands relayed (%s %s)" % (s, json.dumps(rcmds)[:200]))
    if cmd_ids:
        s, one, _ = call("GET", A + "/db-capture/store-commands/" + str(cmd_ids[0]).split("@")[0] + "@" + a_b["slug"])
        ok(s == 200 and "refund:7:fee" in json.dumps(one), "one Redis command read by its id (%s)" % s)
    s, sums, _ = call("GET", A + "/db-capture/summaries?callIds=" + some + "@" + a_b["slug"])
    ok(s == 200 and (some + "@" + a_b["slug"]) in json.dumps(sums), "statement summaries keyed by the tagged id (%s %s)" % (s, sums))
    # explicit relay path, untagged
    s, c2, _ = call("GET", A + "/links/r/" + a_b["slug"] + "/session-cycles/" + cycle)
    ok(s == 200 and c2.get("id") == cycle, "explicit relay answers untagged")
    # board-judging data
    s, cc2, _ = call("GET", A + "/links/r/" + a_b["slug"] + "/links/data/cycle-calls?cycleId=" + cycle)
    ok(s == 200 and len(cc2) == 3 and all("signature" in x for x in cc2), "owner-signed cycle calls (%s)" % (cc2 if s != 200 else len(cc2)))
    # a write through a stream is refused
    s, w, _ = call("DELETE", A + "/links/r/" + a_b["slug"] + "/session-cycles/" + cycle)
    ok(s in (403, 405), "writes are never relayed (%s)" % s)
    # read log on b
    s, reads, _ = call("GET", B + "/links/reads")
    ok(any(r["linkId"] == b_a["id"] for r in reads), "b logged a's reads")

    # requests: a note on a call
    s, r, _ = call("POST", A + "/links/requests", {"via": a_b["slug"], "streamId": st["id"], "kind": "CALL_NOTE", "target": some,
                                                    "targetLabel": "GET /odeysys/refunds/7", "text": "why 500?",
                                                    "extra": json.dumps({"cycleId": cycle, "block": "response-body", "lineIndex": 0, "lineText": ""})})
    ok(s == 200 and r["state"] == "WAITING", "request sent, waiting (%s %s)" % (s, r))
    s, waiting, _ = call("GET", B + "/links/requests/waiting")
    ok(waiting["waiting"] == 1, "b has 1 waiting request")
    s, acc, _ = call("POST", B + "/links/requests/" + r["id"] + "/accept")
    ok(s == 200 and acc["state"] == "ACCEPTED" and acc["resultRef"].startswith("call:"), "accepted (%s)" % acc)
    s, again, _ = call("POST", B + "/links/requests/" + r["id"] + "/reject")
    ok(s == 409, "second answer refused (first wins)")
    s, notes, _ = call("GET", B + "/comments?callId=" + some)
    ok(any("why 500?" in n["comment"] and "PC-1" in n["comment"] for n in notes), "note made on b, author named")
    s, inc, _ = call("GET", B + "/links/requests?incoming=true&limit=5")
    label = [x.get("targetLabel") for x in inc if x["id"] == r["id"]]
    ok(label and label[0].startswith("GET ") and "/odeysys/refunds/7" in label[0], "b names the call itself (%s)" % label)
    tagged = some + "@" + a_b["slug"]
    s, counts, _ = call("GET", A + "/comments/counts?callIds=" + urllib.parse.quote(tagged, safe=""))
    ok(s == 200 and tagged in counts, "comment counts come back keyed by the tagged id (%s %s)" % (s, counts))
    time.sleep(1)
    s, mine, _ = call("GET", A + "/links/requests?incoming=false")
    ok(any(x["id"] == r["id"] and x["state"] == "ACCEPTED" for x in mine), "a sees it accepted")
    s, und, _ = call("POST", B + "/links/requests/" + r["id"] + "/undo")
    s, notes, _ = call("GET", B + "/comments?callId=" + some)
    ok(not any("why 500?" in n["comment"] for n in notes), "undo removed the note")
    # withdraw
    s, r2, _ = call("POST", A + "/links/requests", {"via": a_b["slug"], "streamId": st["id"], "kind": "CALL_NOTE", "target": some,
                                                     "text": "second", "extra": json.dumps({"cycleId": cycle})})
    s, wd, _ = call("POST", A + "/links/requests/" + r2["id"] + "/withdraw")
    ok(s == 200 and wd["state"] == "WITHDRAWN", "withdrawn (%s)" % wd)
    # view mode refuses requests
    call("PATCH", B + "/links/streams/" + st["id"], {"mode": "VIEW"})
    time.sleep(1)
    s, r3, _ = call("POST", A + "/links/requests", {"via": a_b["slug"], "streamId": st["id"], "kind": "CALL_NOTE", "target": some, "text": "x",
                                                     "extra": json.dumps({"cycleId": cycle})})
    ok(s == 403 and r3.get("error") == "VIEW_ONLY", "view-only stream refuses requests (%s)" % r3)
    # auto-accept
    call("PATCH", B + "/links/streams/" + st["id"], {"mode": "COMMENT", "autoAccept": True})
    time.sleep(1)
    s, r4, _ = call("POST", A + "/links/requests", {"via": a_b["slug"], "streamId": st["id"], "kind": "CALL_NOTE", "target": some, "text": "auto",
                                                     "extra": json.dumps({"cycleId": cycle})})
    ok(s == 200 and r4["state"] == "ACCEPTED" and r4["auto"], "auto-accepted (%s)" % r4)

    # a big body crosses the link whole, in chunks under flow control (3 MB > 8 x 128 KB initial credit)
    big = '{"rows":"' + ("x" * 3_000_000) + '"}'
    big_id = post_call(B, "odeysys", "/odeysys/export/big", 200, big)
    time.sleep(2)
    s, bd, _ = call("GET", A + "/internal-calls/" + big_id + "@" + a_b["slug"] + "/detail")
    body_len = len(json.dumps(bd)) if s == 200 else 0
    ok(s == 200 and "x" * 3_000_000 in json.dumps(bd), "3 MB body relayed whole (%s, %d chars)" % (s, body_len))
    # a local write naming a remote thing is refused - a note on its call is a request
    s, wr, _ = call("POST", A + "/comments", {"callId": some + "@" + a_b["slug"], "block": "response-body", "lineIndex": 0,
                                             "lineText": "", "comment": "local note"})
    ok(s == 409 and wr.get("error") == "REMOTE_WRITE", "local comment on a remote call refused (%s %s)" % (s, wr))
    s, wr2, _ = call("PUT", A + "/session-cycles/" + ref, {"name": "renamed"})
    ok(s == 409, "rename of a remote cycle refused (%s)" % s)
    # the reader says it kept a copy; the owner's read log names it
    s, _, _ = call("GET", A + "/session-cycles/" + ref + "?alfredPurpose=copy")
    time.sleep(0.5)
    s, reads2, _ = call("GET", B + "/links/reads")
    ok(any(r["family"] == "copy" for r in reads2), "owner's read log says a copy was kept")
    # discovery answers here (Docker: not available, with the reason)
    s, disc, _ = call("GET", A + "/links/discovered")
    ok(s == 200 and disc["available"] is False and disc["why"], "discovery says why it is off in Docker (%s)" % disc)

    # host a puts b's cycle on its board
    s, board, _ = call("GET", A + "/board/boards?project=odeysys")
    s, nb, _ = call("POST", A + "/board/boards", {"project": "odeysys", "name": "dashboard enhancements"})
    bid = (nb.get("board") or nb).get("id") if isinstance(nb, dict) else None
    ok(s in (200, 201) and bid, "host board made (%s %s)" % (s, nb if s != 200 else ""))
    if bid:
        s, rel, _ = call("PUT", A + "/board/boards/" + bid + "/cycles/" + ref)
        ok(s in (200, 204), "remote cycle related to host board (%s %s)" % (s, rel))
        s, cyc_of, _ = call("GET", A + "/board/cycles/" + urllib.parse.quote(ref, safe="") + "/boards")
        ok(s == 200, "boards of remote cycle answered locally (%s %s)" % (s, cyc_of))
        # an Acceptance item of a's board judged by b's calls: GET /odeysys/refunds/{x} must answer 2xx - call 7 answered 500
        s, sp, _ = call("PUT", A + "/board/boards/" + bid + "/specs/spec.md",
                        b"# Refunds\n## Acceptance\n- Opening a refund shows it.\n")
        ok(s == 200, "spec saved on a's board (%s %s)" % (s, sp))
        s, reqs, _ = call("GET", A + "/board/boards/" + bid + "/requirements")
        keys = find_all(reqs, "itemKey")
        ok(s == 200 and keys, "a's board lists the item (%s %s)" % (s, keys))
        if keys:
            s, ev, _ = call("PUT", A + "/board/boards/" + bid + "/evidence", {
                "fileName": "spec.md", "itemKey": keys[0], "project": "odeysys", "endpoint": "GET /odeysys/refunds/{x}",
                "checks": [{"kind": "STATUS", "range": "2xx"}]})
            ok(s == 200, "evidence put (%s %s)" % (s, ev))
            verdict = None
            for _ in range(15):
                s, reqs, _ = call("GET", A + "/board/boards/" + bid + "/requirements")
                verdict = find_all(reqs, "verdict")
                if "WRONG" in verdict:
                    break
                time.sleep(1)
            ok("WRONG" in verdict, "the item is judged WRONG from b's call that answered 500 (%s)" % verdict)
            time.sleep(1)
            s, cards, _ = call("GET", A + "/board/cards?cycleId=" + bid)
            ok("Wrong result" in json.dumps(cards), "a card for it opened on a's board (%s)" % find_all(cards, "title"))
            wrong = [c for c in (cards if isinstance(cards, list) else cards.get("cards", cards.get("items", [])))
                     if "Wrong result" in json.dumps(c)]
            wid = find_all(wrong[0], "id")[0] if wrong else None
            s, wcard, _ = call("GET", A + "/board/cards/" + str(wid)) if wid else (0, None, None)
            refs = [x for x in find_all(wcard, "ref") if str(x).startswith("in:")]
            ok(refs and all(x.endswith("@" + a_b["slug"]) and x.count("@") == 2 for x in refs),
               "the card links b's call in its cycle on its link (%s)" % refs)
        # a card on a's board that names b's call: its badge shows on the streamed call
        mention = "@[call:in:" + some + "@" + cycle + "@" + a_b["slug"] + "|GET /odeysys/refunds/7 · 500]"
        s, card, _ = call("POST", A + "/board/cards", {"project": "odeysys", "kind": "BUG", "title": "Refund 7 cannot be opened",
                                                        "description": "STG answers 500: " + mention, "cycleId": bid})
        ok(s in (200, 201), "card mentioning b's call made (%s %s)" % (s, card if s not in (200, 201) else ""))
        s, badges, _ = call("GET", A + "/board/call-badges?callIds=" + urllib.parse.quote(some + "@" + a_b["slug"], safe=""))
        ok(s == 200 and (some + "@" + a_b["slug"]) in badges, "the streamed call carries the card's badge (%s %s)" % (s, badges))

    # b streams its own board to a; a comments on a card through a request b accepts
    s, bb, _ = call("POST", B + "/board/boards", {"project": "odeysys", "name": "refund fixes"})
    bboard = (bb.get("board") or bb).get("id") if isinstance(bb, dict) else None
    s, bcard, _ = call("POST", B + "/board/cards", {"project": "odeysys", "kind": "TASK", "title": "Fee is null on approve",
                                                     "description": "RefundService.approve", "cycleId": bboard})
    bcard_id = (bcard.get("card") or bcard).get("id") if isinstance(bcard, dict) else None
    ok(bboard and bcard_id, "b's own board and card (%s %s)" % (bboard, bcard_id))
    s, bst2, _ = call("POST", B + "/links/streams", {"linkId": b_a["id"], "kind": "BOARD", "target": bboard, "targetName": "refund fixes",
                                                      "project": "odeysys", "mode": "COMMENT"})
    ok(s == 200, "b streams its board to a (%s)" % s)
    time.sleep(1.5)
    s, rb, _ = call("GET", A + "/board/boards/" + bboard + "@" + a_b["slug"])
    ok(s == 200, "a reads b's board (%s)" % s)
    s, rcards, _ = call("GET", A + "/board/cards?cycleId=" + urllib.parse.quote(bboard + "@" + a_b["slug"], safe=""))
    ok(s == 200 and "Fee is null on approve" in json.dumps(rcards) and (bcard_id + "@" + a_b["slug"]) in json.dumps(rcards),
       "a reads b's cards, ids tagged (%s)" % s)
    s, wcard, _ = call("POST", A + "/board/cards/" + bcard_id + "@" + a_b["slug"] + "/comments", {"text": "local"})
    ok(s in (403, 409), "a cannot write on b's card directly (%s %s)" % (s, wcard))
    s, rq, _ = call("POST", A + "/links/requests", {"via": a_b["slug"], "streamId": bst2["id"], "kind": "CARD_COMMENT", "target": bcard_id,
                                                     "targetLabel": "Fee is null on approve", "text": "STG shows the same 500 on refund 7"})
    ok(s == 200 and rq.get("state") == "WAITING", "card comment asked of b (%s %s)" % (s, rq))
    s, acc2, _ = call("POST", B + "/links/requests/" + rq["id"] + "/accept")
    ok(s == 200 and acc2["state"] == "ACCEPTED", "b accepts (%s)" % acc2)
    s, act, _ = call("GET", A + "/board/cards/" + bcard_id + "@" + a_b["slug"] + "/activity")
    ok(s == 200 and "STG shows the same 500 on refund 7" in json.dumps(act), "a sees the comment on b's card (%s)" % s)
    call("POST", B + "/links/requests/" + rq["id"] + "/undo")
    s, act2, _ = call("GET", B + "/board/cards/" + bcard_id + "/activity")
    # card history is never rewritten: undo strikes the comment through and says it was taken back
    ok(s == 200 and "**PC-1:** STG shows the same 500 on refund 7~~ *(taken back)*" in json.dumps(act2, ensure_ascii=False),
       "undo takes it back on b's card (%s)" % find_all(act2, "text"))

    # pass-through (D8): a streams its board to c; c reads b's cycle through a only when b allows passing on
    a_c = link_of(A, "Ninety")
    c_a = link_of(C, "PC-1")
    s, bst, _ = call("POST", A + "/links/streams", {"linkId": a_c["id"], "kind": "BOARD", "target": bid, "targetName": "dashboard enhancements",
                                                     "project": "odeysys", "mode": "VIEW"})
    ok(s == 200, "a streams its board to c")
    time.sleep(1.5)
    far = cycle + "@" + a_b["slug"] + "@" + c_a["slug"]
    s, body, _ = call("GET", C + "/session-cycles/" + far)
    ok(s == 403 and body.get("error") == "NOT_PASSED_ON", "b has not allowed passing on (%s %s)" % (s, body))
    call("PATCH", B + "/links/streams/" + st["id"], {"passOn": True, "passMode": "VIEW"})
    time.sleep(1.5)
    s, body, _ = call("GET", C + "/session-cycles/" + far)
    ok(s == 200 and body.get("id") == far, "c reads b's cycle through a (%s %s)" % (s, body if s != 200 else body.get("id")))
    s, cc3, _ = call("GET", C + "/session-cycles/" + far + "/internal-calls")
    items3 = cc3 if isinstance(cc3, list) else cc3.get("calls", cc3.get("items", []))
    ok(len(items3) == 4 and "secret-123" not in json.dumps(cc3), "passed-on calls, masked (%d)" % len(items3))
    s, reads_b, _ = call("GET", B + "/links/reads")
    ok(any(r.get("via") for r in reads_b), "b's read log names the reader behind a")
    s, brd, _ = call("GET", C + "/board/boards/" + bid + "@" + c_a["slug"])
    ok(s == 200 and brd.get("id", brd.get("board", {}).get("id", "")).startswith(bid), "c reads a's board (%s)" % s)
    s, body, _ = call("GET", C + "/board/boards/default:odeysys@" + c_a["slug"])
    ok(s == 403, "c cannot read a board not streamed to it (%s)" % s)

    # environments (D35-D41): b does STG of a's board
    s, defs, _ = call("PUT", A + "/links/envs/" + bid, {"boardName": "dashboard enhancements", "project": "odeysys",
                                                         "envs": [{"name": "DEV", "linkId": None, "required": False},
                                                                  {"name": "STG", "linkId": a_b["id"], "required": True}]})
    ok(s == 200 and len(defs) == 2, "a names DEV and STG (%s %s)" % (s, defs))
    time.sleep(1.5)
    s, asg, _ = call("GET", B + "/links/env/assignments")
    ok(any(x["env"] == "STG" and x["boardId"] == bid for x in asg), "b knows it is STG (%s)" % asg)
    s, mk, _ = call("PUT", B + "/links/env/" + b_a["slug"] + "/" + bid + "/steps", {"stepKey": "k1", "state": "SEEN", "claude": True})
    ok(s == 200 and mk["actor"] == "claude", "b's Claude ticks a step for STG (%s)" % mk)
    s, eb, _ = call("GET", A + "/links/envs/" + bid)
    stg = [c for c in eb["columns"] if c["name"] == "STG"][0]
    ok("asks" in eb and "asks" in stg, "the matrix says what it asks (%s)" % eb.get("asks"))
    ok(stg["online"] and len(stg["steps"]) == 1, "a sees STG's tick live (%s)" % stg)
    ok(eb["overall"] in ("PASS", "WAITING", "FAIL"), "overall computed (%s, waiting on %s)" % (eb["overall"], eb["waitingOn"]))
    s, rec, _ = call("POST", B + "/links/env/" + b_a["slug"] + "/" + bid + "/record", {"retestFor": []})
    ok(s == 200 and rec["env"] == "STG", "b records a test cycle for STG (%s %s)" % (s, rec))
    s, bcycles, _ = call("GET", B + "/session-cycles")
    recording = [c["name"] for c in bcycles if c.get("status") == "RECORDING" and c.get("assignedTo") == "odeysys"]
    ok(len(recording) == 1, "only the STG test cycle records odeysys on b (%s)" % recording)
    time.sleep(2)
    s, ecs, _ = call("GET", A + "/links/envs/" + bid + "/cycles")
    ok(any(c["cycleRef"] == rec["cycleRef"] + "@" + a_b["slug"] for c in ecs), "a has b's STG cycle (%s)" % ecs)
    s, bc, _ = call("GET", A + "/board/cycles/" + rec["cycleRef"] + "@" + a_b["slug"] + "/boards")
    ok(s == 200 and bid in json.dumps(bc), "STG cycle is on a's board (%s %s)" % (s, bc))
    s, rt, _ = call("POST", B + "/links/env/" + b_a["slug"] + "/" + bid + "/retest", {"cards": [], "cycleId": rec["cycleRef"]})
    ok(s == 200, "b's re-test judged by the host (%s %s)" % (s, rt))

    # stream ended
    call("DELETE", B + "/links/streams/" + st["id"])
    time.sleep(1.5)
    s, body, _ = call("GET", A + "/session-cycles/" + ref)
    ok(s == 403, "ended stream -> refused (%s)" % s)
    s, mirrors, _ = call("GET", A + "/links/streams?mine=false&ended=true")
    ok(any(m["id"] == st["id"] and m.get("endedAt") for m in mirrors), "a's copy says ended")
    s, _, _ = call("DELETE", A + "/links/streams/" + st["id"])
    s2, mirrors, _ = call("GET", A + "/links/streams?mine=false&ended=true")
    ok(s == 204 and not any(m["id"] == st["id"] for m in mirrors), "the reader removes its ended copy (%s)" % s)

    # offline
    print("failures:", failures)
    return failures


if __name__ == "__main__":
    sys.exit(main())
