package com.fathy.alfred.backend.relive.application.port.in;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Inbound port: evaluate a step's checks against one answer - the recording (the editor's
 * "On the recording" preview) or the answer a run got (its result). The proxy does the evaluating,
 * with the rule engine's own condition code, so a check and a rule condition never disagree.
 *
 * <p>{@code request} is {@code {"groups": [{"combine", "conditions"}...], "answer": {"status",
 * "headers", "body"}, "responseTimeMs"}}; the result is {@code {"groups": [{"passed", "rows"}...]}}.
 */
public interface EvaluateChecksUseCase {

    JsonNode evaluate(JsonNode request);

    /** The proxy could not be reached or did not answer - checks cannot be evaluated right now. */
    class ChecksUnavailableException extends RuntimeException {
        public ChecksUnavailableException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
