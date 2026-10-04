package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import jakarta.validation.constraints.Size;

import java.util.List;

/**
 * Sample lines read in the browser (uploads), a path under the server logs folder, or a file of a watched
 * folder ({@code watchFolder} + {@code watchPath}, the path below that folder).
 */
public record PreviewRequestDto(@Size(max = 1000) List<String> sampleLines, @Size(max = 1024) String serverPath,
                                @Size(max = 40) String watchFolder, @Size(max = 1024) String watchPath) {
}
