package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.Size;

public record UpdateSourceRequestDto(@Size(min = 1, max = 80) String name, Long retentionMaxBytes) {
}
