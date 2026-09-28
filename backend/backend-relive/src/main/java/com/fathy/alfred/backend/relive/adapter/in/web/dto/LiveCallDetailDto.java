package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;

import java.util.List;

/** {@code GET /relive-cycles/{id}/live-calls/{liveId}} (contracts/rest-api.md): the live call's
 *  own fields flattened alongside {@code secrets} - the frontend masks, this only lists names. */
public record LiveCallDetailDto(@JsonUnwrapped LiveCall liveCall, List<String> secrets) {
}
