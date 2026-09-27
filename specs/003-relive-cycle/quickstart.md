# Quickstart: trying a Relive Cycle end to end

Prerequisites: ALFRED running (`python3 start.py`), inbound logging on for your project (e.g. `odeysys`), its
outbound traffic going through its forward-proxy listener, and at least one recorded session cycle containing an
inbound call with outbound supplier children.

## 1. Build

1. Open **Relive** in the top nav → **New cycle** → name it "Book flow repro".
2. **Add calls** → pick the session cycle → select Login, Search, Price, Book. Search appears with its three
   supplier children nested under it; each child shows **REPLAY**.
3. Set Supplier B to **LIVE**. The overview header now reads "1 call can reach an external system".
4. On Search add an extraction `searchId = response.body.searchId`; in Price's body replace the recorded id with
   `{{searchId}}`.
5. Save. The recorded calls in the session cycle are unchanged.

## 2. Run

1. Press **Run** → driver **Automatic**. The pre-run summary lists Supplier B as LIVE and asks you to confirm.
2. Watch the checklist: Login ✓, Search running with children turning REPLAYED / LIVE, `searchId` appearing in the
   Variables panel, progress "n / 7".
3. Open Supplier B: original vs actual, differences split into unexpected / expected / noise.

## 3. Prove REPLAY never reached a supplier (SC-002)

Point Supplier A and C at a stub that counts requests (e.g. a tiny HTTP server logging hits) before recording, or
compare Live Calls: during the run only Supplier B's call appears with a real upstream; A and C show as answered by
ALFRED (`relive` attribution with `REPLAYED`). The stub for A/C must show zero hits.

## 4. History

Run again after editing Price; open **History** → both runs listed → **Compare**.

## 5. Guided

Press **Run** → **Guided**, then click through the app yourself. The run view highlights the expected next step and
ticks steps off as your calls arrive; REPLAY children are answered underneath.
