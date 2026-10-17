package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/** Idempotent - starting recording on an already-recording cycle just returns it unchanged. */
public interface StartRecordingUseCase {

    Optional<SessionCycle> startRecording(String id);

    /** What a guarded start did: started (cycle), or not, because {@code running} records the same project. */
    record GuardedStart(SessionCycle cycle, SessionCycle running) {
        public boolean conflict() {
            return running != null && (cycle == null || cycle.status() != com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus.RECORDING);
        }
    }

    /**
     * Starts or resumes recording (specs/027 FR-008). When another cycle records the same project: with {@code pauseOther}
     * that one is paused first, else nothing starts and the running one is returned. Empty when there is no such cycle.
     */
    default Optional<GuardedStart> startRecording(String id, boolean pauseOther) {
        return startRecording(id).map(c -> new GuardedStart(c, null));
    }
}
