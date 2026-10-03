package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

public record CreateUploadRequestDto(@NotBlank @Size(max = 255) String fileName, @Positive long size) {
}
