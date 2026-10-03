package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code query.cursor}/{@code limit} page through one node's lines; {@code skipped} picks its level-skipping lines. */
public record NodeLinesRequestDto(LogQuery query, @NotBlank @Size(max = 4096) String path, boolean skipped) {
}
