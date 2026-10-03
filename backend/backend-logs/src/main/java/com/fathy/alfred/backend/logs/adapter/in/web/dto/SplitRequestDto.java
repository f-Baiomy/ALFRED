package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record SplitRequestDto(@NotBlank @Size(max = 80) String name) {
}
