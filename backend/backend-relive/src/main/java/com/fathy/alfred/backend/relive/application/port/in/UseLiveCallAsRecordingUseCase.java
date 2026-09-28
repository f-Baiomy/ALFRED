package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;

/**
 * Inbound port: "Use as recording" (FR-015b, T073) - replaces a step's frozen recording with a
 * live call's actual request/response, and updates the step's call rule's {@code MOCK_RESPONSE}
 * action (if it has one) the same way, so REPLAY continues to answer with what really happened.
 * Persisted through the versioned cycle update (reason {@code USE_LIVE_CALL}), so it can be
 * undone via {@code versions/{v}/restore} like every other rebuild-style change.
 */
public interface UseLiveCallAsRecordingUseCase {

    /** @throws IllegalArgumentException when the cycle, the live call, or the step doesn't exist. */
    ReliveCycle useAsRecording(String cycleId, String liveCallId, String stepKey);
}
