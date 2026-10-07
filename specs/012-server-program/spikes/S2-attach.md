# SPIKE S2: attaching from a newer JDK to running JDK 8 and 11 apps

**Date**: 2026-10-07. **Result**: PASS, with two rules the attach CLI must follow.

## What ran

A tiny target app polls a system property. An agent (`Agent-Class`, compiled for Java 8) sets that
property in `agentmain`. An attacher on a newer JDK (`jdk.attach`) attaches and calls `loadAgent`.

| Attacher | Target | OS | Same user | Result |
|---|---|---|---|---|
| JDK 22 | JDK 8 (1.8.0_191) | Windows 10 | yes | agent ran; `loadAgent` threw `AgentLoadException: 0` |
| JDK 22 | JDK 11 | Windows 10 | yes | agent ran; `loadAgent ok` |
| JDK 21 (Temurin) | JDK 8 (1.8.0_504) | Linux | root → root | agent ran; `AgentLoadException: Failed to load agent library: 0` |
| JDK 21 | JDK 8 | Linux | root → user `app` (direct) | **fails**: `Unable to open socket file /tmp/.java_pid…`; the target also prints a full thread dump (the attach sends SIGQUIT) |
| JDK 21 via `runuser -u app` | JDK 8 | Linux | yes (switched) | agent ran; same `…: 0` quirk |

## Rules for `attach-cli` (research R12/R16)

1. **The JDK 8 reply quirk**: a JDK 9+ attach client expects `return code: 0`, but a JDK 8 target
   answers `0`, so `loadAgent` throws `AgentLoadException` whose message ends in `0` even though the
   agent loaded and ran. Treat exactly that case as success, then confirm through the system
   property the agent publishes (`alfred.agent.features`). Any other `AgentLoadException` is a real
   failure.
2. **Never attach across users directly**: a failed cross-user attach makes the target dump all its
   threads to its console. Before attaching, compare the target's owner (`/proc/<pid>` uid on
   Linux) with the caller's; if they differ, re-run the attach step as the owner through
   `runuser -u <owner>` (or `su -s /bin/sh <owner> -c`).

## Not covered here

- Windows Server and a JVM in another session (LocalSystem service → interactive Administrator
  app). Windows Server is not available on this machine. It is recorded as an open risk in
  `docs/server.md`; the CLI reports a clear error if `openProcess` fails.
- JDK 17 targets: the attach protocol is identical from 11 on, so no result is expected to differ.
  Covered by the US9 IT on whatever JDK runs the tests.
