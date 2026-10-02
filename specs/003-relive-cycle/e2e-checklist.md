# Relive Cycle - manual end-to-end check (T082)

Run on a machine with Docker. Each step names what to look at; tick it when it holds.

## Setup

1. `docker compose up -d --build backend proxy reverse-proxy frontend`, then `docker compose restart app-gateway`.
2. A stub supplier that counts requests (any HTTP echo server reachable through the forward proxy), and the
   application under test configured to use ALFRED's forward proxy.
3. Record one session cycle: Login, Search (Search calls Supplier A, B and C - in parallel if the app does),
   Price, Book.

## Checks

- [X] **Build (US1)**: New cycle from the session cycle; Search shows A, B, C nested. Reorder, disable, duplicate,
      save, reload - the cycle is unchanged and the recording in Live Calls is byte-for-byte the same.
- [X] **SC-002 mixed modes**: A REPLAY, B LIVE, C REPLAY. Run (Automatic). The stub receives exactly one call (B).
      All three children settle - none is NOT_CALLED or unexpected, including when A/B/C are called in parallel.
- [X] **First second of a run (B3)**: start a run whose first step calls a REPLAY supplier immediately. The stub
      receives nothing.
- [X] **Request changed (FR-014d)**: edit Search's request body. A REPLAY child set to "Ask me" shows a held box in
      the run view with a countdown; Replay recorded answer answers from the recording; letting it time out gives a
      502 mock; the stub receives nothing either way. "Send to real" asks twice and then reaches the stub once.
- [X] **Checkpoints (US3b)**: Book "pause after": Replay twice with an edit (Edit & replay), Continue. History shows
      three attempts. Supplier B "pause before, 10 s": untouched, it continues on its own (LIVE: the stub gets it).
      A REPLAY child with "pause before": Continue - the stub receives nothing.
- [X] **Hold and continue (US3 6a)**: make Book fail. The run holds; Continue with next calls skips the step that
      needs Book's value, with the reason shown.
- [X] **Guided (FR-030a)**: start Guided, click through the real app. Each step is ticked in order, supplier calls
      replay (no 502 "claimed by more than one run"), a double-click stays on the same step.
- [X] **Run from here (FR-036)**: from a finished run, Run from Price. Login and Search are not sent again; the
      pre-run dialog appears.
- [X] **Relive now (FR-003c)**: select calls in Live Calls, Relive now, let it finish, then Save as cycle. The
      cycle is in the list after a reload.
- [X] **Live calls log (FR-015b)**: after a run with B LIVE, History → Live calls lists B's call; REPLAY calls are
      not listed.
- [X] **Leases (B4)**: finish a run, close the tab, wait 20 s, reopen. The run still shows its real outcome (not
      INTERRUPTED). In the same tab, "Continue with the rest" on a failed run works (no 409).
- [X] **Differences (FR-039-041c)**: a step whose total changed shows per-field rows; "Ignore this field (cycle)"
      then Save; the next run counts it as noise.
- [X] **Logging off (B8)**: turn the project's inbound logging off; a run still replays its children.
- [X] **SC-010 isolation**: two runs from different cycles at once plus unrelated traffic through the proxy. Neither
      run's REPLAY answers or rules touch the other's calls or the unrelated traffic.

## Run on 2026-10-02 (T082)

All checks pass on branch `fix/003-relive-review`, against the Docker stack built from that branch and
the test app in [e2e/stub_app.py](./e2e/stub_app.py):
- `python specs/003-relive-cycle/e2e/stub_app.py --supplier-host <docker host IP>` starts the stub
  supplier (counts requests, `GET /__count`) and the app on 9003 (`core-service:8083:9003`).
- Search fans out to suppliers A, B and C in parallel.

Bugs this run found, each fixed and covered by a test before the check was repeated:

| Found at | Bug | Commit |
|---|---|---|
| SC-002 | Parallel supplier calls right after a run started were not attributed: a REPLAY supplier reached the real host | `fix(relive): parallel supplier calls wait for the run scan in progress` |
| SC-002 | A LIVE step never called read "REPLAY - Not called" | `fix(relive): a step not called yet shows its own mode` |
| Request changed | A decided held call stayed in the run view, counting down | `fix(relive): a decided held call leaves the run view` |
| Request changed | A LIVE child answered by ALFRED read "contacted host" and counted as a real call; a disabled step read Cancelled | `fix(relive): mocked LIVE calls are not "contacted host"...` |
| Restart | The backend crash-looped after a restart with a run left RUNNING (bean cycle) | `fix(relive): backend starts when a run was left RUNNING` |
| Checkpoints | A checkpoint on a REPLAY child could not be saved (rule validation) | `fix(relive): checkpoints on REPLAY children can be saved` |
| Checkpoints | A checkpoint hid a LIVE call from the external-systems check | `fix(relive): a checkpoint does not hide a LIVE call...` |
| Checkpoints | **Safety**: Continue at a checkpoint ran into "Ask me" and sent the call to the real host | `fix(relive): a checkpoint released into "Ask me" is held again, never sent` |
| Checkpoints | An inbound step's "pause after" was held twice (proxy, then tab) | `fix(relive): an inbound step's checkpoint is held once, by the tab` |
| Hold and continue | A skipped step was stored as Cancelled; Live calls lost their logged call id (Resend/Export did nothing) | `fix(relive): Live calls keep their logged call; skipped steps stay Skipped` |
| Run from here | Offered only on failed steps; pre-run summary listed steps that are not sent | `fix(relive): Run from here on any step of an ended run`, `fix(relive): run-view polish` |
| Relive now | An inbound call came without its supplier children | `fix(relive): Relive now brings supplier children; Guided keeps End run` |
| Guided | End run disappeared once every step had been called | same |

Known limitation (not a cross-run leak): while two runs of the **same project** both have an inbound
call in flight, the forward proxy cannot tell which run an untagged outbound call belongs to. It
blocks those calls ("claimed by more than one run"), including traffic from the same host that
belongs to neither run. Nothing is replayed for the wrong run (SC-010: 0 wrong-run answers out of 30
calls). Runs of different projects, or an app that forwards `X-Alfred-Relive`/`X-Operation-Id`,
are not affected.
