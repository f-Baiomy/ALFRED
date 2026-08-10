package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/** Idempotent - pausing an already-paused cycle just returns it unchanged. */
public interface PauseRecordingUseCase {

    Optional<SessionCycle> pauseRecording(String id);
}
