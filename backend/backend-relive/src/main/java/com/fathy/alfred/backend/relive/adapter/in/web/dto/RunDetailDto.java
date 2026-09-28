package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.StepResult;

import java.util.List;

/** {@code GET /relive-cycles/{id}/runs/{runId}} (contracts/rest-api.md): the run's own fields
 *  flattened alongside {@code stepResults} and {@code secrets} - not nested under a {@code run}
 *  key, since the frontend (`ReliveApiService.getRun`) reads e.g. {@code full.definition} and
 *  {@code full.id} directly off the top-level response. */
public record RunDetailDto(@JsonUnwrapped Run run, List<StepResult> stepResults, List<String> secrets) {
}
