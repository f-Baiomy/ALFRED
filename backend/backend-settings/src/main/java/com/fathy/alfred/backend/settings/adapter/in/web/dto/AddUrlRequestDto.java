package com.fathy.alfred.backend.settings.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;

/** {@code host} accepts anything the user types (a full URL, with or without scheme/path/query) - HostNormalizer extracts the bare hostname before it's stored. */
public record AddUrlRequestDto(@NotBlank String host) {
}
