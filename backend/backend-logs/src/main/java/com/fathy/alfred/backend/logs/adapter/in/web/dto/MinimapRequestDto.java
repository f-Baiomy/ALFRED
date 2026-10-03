package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.LogQuery;

import java.util.List;

/** {@code condition}: pills the minimap marks; empty = ERROR and WARN (FR-027). */
public record MinimapRequestDto(LogQuery query, List<LogQuery.Pill> condition) {
}
