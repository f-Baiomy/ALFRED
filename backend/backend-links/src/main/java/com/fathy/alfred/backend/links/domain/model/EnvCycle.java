package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * A test cycle recorded for one environment of a board (D38, D41). On the host: {@code hostLinkId} is null, the board is
 * the host's own and {@code cycleRef} is a local id or {@code <id>@<slug>} for one an environment Alfred recorded. On an
 * environment Alfred: {@code hostLinkId} names the host, the board is the host's, and the cycle is its own.
 * {@code retestFor} holds the Fixed cards a re-test cycle was recorded for (only its calls count for them there).
 */
public record EnvCycle(String hostLinkId, String boardId, String cycleRef, String env, String name, List<Integer> retestFor, Instant at) {

    public EnvCycle {
        retestFor = retestFor == null ? List.of() : List.copyOf(retestFor);
    }
}
