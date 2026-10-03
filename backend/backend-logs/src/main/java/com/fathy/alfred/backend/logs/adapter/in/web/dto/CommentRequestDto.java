package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code path}: the field path the comment is on, or empty for the whole line (FR-042). */
public record CommentRequestDto(@Size(max = 1024) String path, @NotBlank @Size(max = 4000) String text,
                                @Size(max = 64) String authorProfileId) {
}
