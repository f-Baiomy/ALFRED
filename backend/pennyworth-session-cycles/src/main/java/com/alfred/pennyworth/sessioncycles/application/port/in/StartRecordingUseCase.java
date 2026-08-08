package com.alfred.pennyworth.sessioncycles.application.port.in;

import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/** Idempotent - starting recording on an already-recording cycle just returns it unchanged. */
public interface StartRecordingUseCase {

    Optional<SessionCycle> startRecording(String id);
}
