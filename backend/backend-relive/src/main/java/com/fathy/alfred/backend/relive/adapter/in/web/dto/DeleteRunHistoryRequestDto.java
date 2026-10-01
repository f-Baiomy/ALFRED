package com.fathy.alfred.backend.relive.adapter.in.web.dto;

import jakarta.validation.constraints.NotNull;

import java.util.List;

/** Body of {@code POST /relive-cycles/{id}/runs/delete-history}. Null or empty {@code runIds}
 *  wipes the cycle's entire run history. {@code deleteCalls} decides whether the logged calls
 *  those runs produced are deleted too (with their Live-calls rows) or kept. */
public record DeleteRunHistoryRequestDto(List<String> runIds, @NotNull Boolean deleteCalls) {
}
