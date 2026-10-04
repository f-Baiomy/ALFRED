package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;

/** POST /db-capture/agent/batch's body - at most 2,000 statements and 4,000 markers (data-model validation rules). */
public record BatchRequestDto(
        @NotBlank @Size(max = 200) String agentId,
        @NotBlank @Size(max = 200) String project,
        @Valid @Size(max = 2000) List<StatementDto> statements,
        @Valid @Size(max = 4000) List<MarkerDto> markers,
        @Size(max = 4000) Map<String, Long> droppedByCall
) {
    public IngestBatch toDomain() {
        return new IngestBatch(agentId, project,
                statements == null ? List.of() : statements.stream().map(StatementDto::toDomain).toList(),
                markers == null ? List.of() : markers.stream().map(MarkerDto::toDomain).toList(),
                droppedByCall == null ? Map.of() : droppedByCall);
    }
}
