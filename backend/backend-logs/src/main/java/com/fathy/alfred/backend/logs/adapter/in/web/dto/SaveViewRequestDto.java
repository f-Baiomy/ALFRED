package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record SaveViewRequestDto(@NotBlank @Size(max = 80) String name, @NotNull JsonNode state) {
}
