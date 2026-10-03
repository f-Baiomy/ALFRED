package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import jakarta.validation.constraints.Size;

public record GroupsRequestDto(LogQuery query, @Size(max = 4096) String parentPath, int offset, int limit) {
}
