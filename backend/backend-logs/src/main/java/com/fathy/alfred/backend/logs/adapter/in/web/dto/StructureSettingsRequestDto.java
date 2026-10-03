package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.Size;

/** A line structure's name and summary template; blank resets to the automatic name / the source's template. */
public record StructureSettingsRequestDto(@Size(max = 80) String name, @Size(max = 500) String template) {
}
