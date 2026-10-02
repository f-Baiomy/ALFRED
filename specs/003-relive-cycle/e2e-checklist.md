# Relive Cycle - manual end-to-end check (T082)

Run on a machine with Docker. Each step names what to look at; tick it when it holds.

## Setup

1. `docker compose up -d --build backend proxy reverse-proxy frontend`, then `docker compose restart app-gateway`.
2. A stub supplier that counts requests (any HTTP echo server reachable through the forward proxy), and the
   application under test configured to use ALFRED's forward proxy.
3. Record one session cycle: Login, Search (Search calls Supplier A, B and C - in parallel if the app does),
   Price, Book.

## Checks

- [ ] **Build (US1)**: New cycle from the session cycle; Search shows A, B, C nested. Reorder, disable, duplicate,
      save, reload - the cycle is unchanged and the recording in Live Calls is byte-for-byte the same.
- [ ] **SC-002 mixed modes**: A REPLAY, B LIVE, C REPLAY. Run (Automatic). The stub receives exactly one call (B).
      All three children settle - none is NOT_CALLED or unexpected, including when A/B/C are called in parallel.
- [ ] **First second of a run (B3)**: start a run whose first step calls a REPLAY supplier immediately. The stub
      receives nothing.
- [ ] **Request changed (FR-014d)**: edit Search's request body. A REPLAY child set to "Ask me" shows a held box in
      the run view with a countdown; Replay recorded answer answers from the recording; letting it time out gives a
      502 mock; the stub receives nothing either way. "Send to real" asks twice and then reaches the stub once.
- [ ] **Checkpoints (US3b)**: Book "pause after": Replay twice with an edit (Edit & replay), Continue. History shows
      three attempts. Supplier B "pause before, 10 s": untouched, it continues on its own (LIVE: the stub gets it).
      A REPLAY child with "pause before": Continue - the stub receives nothing.
- [ ] **Hold and continue (US3 6a)**: make Book fail. The run holds; Continue with next calls skips the step that
      needs Book's value, with the reason shown.
- [ ] **Guided (FR-030a)**: start Guided, click through the real app. Each step is ticked in order, supplier calls
      replay (no 502 "claimed by more than one run"), a double-click stays on the same step.
- [ ] **Run from here (FR-036)**: from a finished run, Run from Price. Login and Search are not sent again; the
      pre-run dialog appears.
- [ ] **Relive now (FR-003c)**: select calls in Live Calls, Relive now, let it finish, then Save as cycle. The
      cycle is in the list after a reload.
- [ ] **Live calls log (FR-015b)**: after a run with B LIVE, History → Live calls lists B's call; REPLAY calls are
      not listed.
- [ ] **Leases (B4)**: finish a run, close the tab, wait 20 s, reopen. The run still shows its real outcome (not
      INTERRUPTED). In the same tab, "Continue with the rest" on a failed run works (no 409).
- [ ] **Differences (FR-039-041c)**: a step whose total changed shows per-field rows; "Ignore this field (cycle)"
      then Save; the next run counts it as noise.
- [ ] **Logging off (B8)**: turn the project's inbound logging off; a run still replays its children.
- [ ] **SC-010 isolation**: two runs from different cycles at once plus unrelated traffic through the proxy. Neither
      run's REPLAY answers or rules touch the other's calls or the unrelated traffic.
