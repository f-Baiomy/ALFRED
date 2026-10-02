package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.in.EvaluateChecksUseCase;
import com.fathy.alfred.backend.relive.application.port.out.CheckEvaluatorPort;
import org.springframework.stereotype.Service;

/** Hands a step's checks to the evaluator (the proxy) after a shape check - see EvaluateChecksUseCase. */
@Service
public class CheckEvaluationService implements EvaluateChecksUseCase {

    private final CheckEvaluatorPort evaluator;

    public CheckEvaluationService(CheckEvaluatorPort evaluator) {
        this.evaluator = evaluator;
    }

    @Override
    public JsonNode evaluate(JsonNode request) {
        if (request == null || !request.path("groups").isArray() || !request.path("answer").isObject()) {
            throw new IllegalArgumentException("Expected {\"groups\": [...], \"answer\": {...}}");
        }
        return evaluator.evaluate(request);
    }
}
