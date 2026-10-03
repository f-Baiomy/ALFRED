package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.Size;

import java.util.List;

/** Either sample lines read in the browser (uploads) or a path under the server logs folder. */
public record PreviewRequestDto(@Size(max = 1000) List<String> sampleLines, @Size(max = 1024) String serverPath) {
}
