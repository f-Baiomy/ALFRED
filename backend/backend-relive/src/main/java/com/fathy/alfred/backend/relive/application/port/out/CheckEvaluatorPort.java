package com.fathy.alfred.backend.relive.application.port.out;

import com.fasterxml.jackson.databind.JsonNode;

/** Outbound port: whatever evaluates step checks - the forward proxy, in the shipped adapter. */
public interface CheckEvaluatorPort {

    /** @throws com.fathy.alfred.backend.relive.application.port.in.EvaluateChecksUseCase.ChecksUnavailableException when it cannot answer. */
    JsonNode evaluate(JsonNode request);
}
