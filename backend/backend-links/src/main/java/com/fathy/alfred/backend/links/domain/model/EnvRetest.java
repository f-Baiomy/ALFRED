package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * An environment Alfred's re-test verdict for one of the host board's Fixed cards (D40, D41): judged from that
 * environment's own calls, with the re-test cycle whose calls counted. {@code verdict} is PASS, FAIL or UNKNOWN.
 */
public record EnvRetest(String hostLinkId, String boardId, int cardNumber, String verdict, String summary, String cycleId, String actor,
                        Instant at) {
}
