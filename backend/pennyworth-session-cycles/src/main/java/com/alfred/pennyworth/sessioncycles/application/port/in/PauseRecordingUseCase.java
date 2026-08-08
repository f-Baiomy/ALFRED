package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/** Idempotent - pausing an already-paused cycle just returns it unchanged. */
public interface PauseRecordingUseCase {

    Optional<SessionCycle> pauseRecording(String id);
}
