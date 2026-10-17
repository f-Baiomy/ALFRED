package com.fathy.alfred.backend.sessioncycles.application.port.out;

import java.util.Optional;

/**
 * Asked before a cycle starts or resumes recording (specs/027 FR-008, research R3): the id of another RECORDING cycle
 * that would record the same project's calls at the same time - two cycles of the boards of one project. Answered by the
 * board bridge; with no board slice (or a cycle on no board) nothing is ever in the way.
 */
public interface RecordingGuardPort {

    Optional<String> runningConflict(String cycleId);
}
