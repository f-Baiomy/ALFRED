package com.fathy.alfred.backend.sessioncycles.application.port.out;

import java.util.Set;

/**
 * Asked before a session cycle is deleted (specs/027 FR-017, US6): the ids of its calls that boards still mention. When
 * there are some, the cycle is not deleted but kept as "kept from &lt;name&gt;" holding only those calls - every mention
 * of them keeps working, and nothing is rewritten. Answered by the board bridge; none wired: nothing is kept.
 */
public interface CycleRescuePort {

    Set<String> mentionedCalls(String cycleId);

    /** Told once the cycle holds only the mentioned calls, so the boards that mention none of them let it go. */
    default void kept(String cycleId) {
    }
}
