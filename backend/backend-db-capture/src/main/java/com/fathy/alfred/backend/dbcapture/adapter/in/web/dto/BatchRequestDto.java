package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.IngestBatch;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;

/** POST /db-capture/agent/batch's body - at most 2,000 statements, 4,000 markers and 5,000 caught log lines (data-model validation rules). */
public record BatchRequestDto(
        @NotBlank @Size(max = 200) String agentId,
        @NotBlank @Size(max = 200) String project,
        @Valid @Size(max = 2000) List<StatementDto> statements,
        @Valid @Size(max = 4000) List<MarkerDto> markers,
        @Size(max = 4000) Map<String, Long> droppedByCall,
        @Valid @Size(max = 5000) List<LogLineDto> logs,
        @Size(max = 4000) Map<String, Long> droppedLogs,
        @Size(max = 2000) List<RedisCommandDto> redis,
        @Valid @Size(max = 100) List<RedisChunkDto> redisChunks,
        @Size(max = 4000) Map<String, Long> droppedRedis
) {
    public IngestBatch toDomain() {
        return new IngestBatch(agentId, project,
                statements == null ? List.of() : statements.stream().map(StatementDto::toDomain).toList(),
                markers == null ? List.of() : markers.stream().map(MarkerDto::toDomain).toList(),
                droppedByCall == null ? Map.of() : droppedByCall,
                logs == null ? List.of() : logs.stream().map(l -> l.toDomain(project)).toList(),
                droppedLogs == null ? Map.of() : droppedLogs,
                redis == null ? List.of() : redis.stream().map(BatchRequestDto::redisCommand).toList(),
                redisChunks == null ? List.of() : redisChunks.stream().map(RedisChunkDto::toDomain).toList(),
                droppedRedis == null ? Map.of() : droppedRedis);
    }

    /** A command whose fields cannot even be read (bad base64) is kept as an invalid record, never dropped silently. */
    private static IngestBatch.RedisIn redisCommand(RedisCommandDto dto) {
        if (dto == null) {
            return new IngestBatch.RedisIn(null, "invalid record: empty");
        }
        try {
            return new IngestBatch.RedisIn(dto.toDomain(), null);
        } catch (IllegalArgumentException e) {
            return new IngestBatch.RedisIn(dto.withoutBytes().toDomain(), "invalid record: " + e.getMessage());
        }
    }
}
