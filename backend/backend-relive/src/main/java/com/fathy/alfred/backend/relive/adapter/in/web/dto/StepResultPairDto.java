package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fathy.alfred.backend.relive.domain.model.StepResult;

/** One row of {@code GET /relive-cycles/{id}/runs/{a}/compare/{b}} - either side is null when
 *  that run never produced a result for the step (data-model.md/rest-api.md leave the exact shape
 *  underspecified; a step-matched pair list is the simplest reasonable reading). */
public record StepResultPairDto(String stepKey, StepResult a, StepResult b) {
}
