package com.fathy.alfred.backend.logs.adapter.in.web.dto;

import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import jakarta.validation.constraints.Size;

import java.util.List;

/** A selection: explicit line ids, or every line matching {@code allMatching}. {@code text} only for bulk comments. */
public record SelectionRequestDto(@Size(max = 10000) List<String> lineIds, LogQuery allMatching,
                                  @Size(max = 4000) String text, @Size(max = 64) String authorProfileId) {
}
