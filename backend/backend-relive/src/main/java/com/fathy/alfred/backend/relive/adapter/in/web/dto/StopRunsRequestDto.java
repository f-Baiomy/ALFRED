package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import java.util.List;

/** Body of {@code POST /relive-cycles/{id}/runs/stop-all}. Null or empty {@code runIds} stops
 *  every RUNNING run of the cycle; a list stops exactly those of them that are still RUNNING. */
public record StopRunsRequestDto(List<String> runIds) {
}
