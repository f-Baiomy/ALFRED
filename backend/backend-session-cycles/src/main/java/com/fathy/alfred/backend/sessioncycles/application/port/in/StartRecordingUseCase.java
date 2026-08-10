package com.fathy.alfred.backend.sessioncycles.application.port.in;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.Optional;

/** Idempotent - starting recording on an already-recording cycle just returns it unchanged. */
public interface StartRecordingUseCase {

    Optional<SessionCycle> startRecording(String id);
}
