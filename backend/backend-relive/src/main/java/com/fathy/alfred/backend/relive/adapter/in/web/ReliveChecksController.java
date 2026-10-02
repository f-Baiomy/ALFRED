package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.in.EvaluateChecksUseCase;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/** POST /relive-cycles/checks/evaluate - a step's checks against one answer, evaluated by the proxy. */
@RestController
@RequestMapping("/relive-cycles/checks")
public class ReliveChecksController {

    private final EvaluateChecksUseCase evaluateChecks;

    public ReliveChecksController(EvaluateChecksUseCase evaluateChecks) {
        this.evaluateChecks = evaluateChecks;
    }

    @PostMapping("/evaluate")
    public JsonNode evaluate(@RequestBody JsonNode request) {
        try {
            return evaluateChecks.evaluate(request);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage(), e);
        } catch (EvaluateChecksUseCase.ChecksUnavailableException e) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, e.getMessage(), e);
        }
    }
}
