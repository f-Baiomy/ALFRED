package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** A CALL_OPEN or HTTP_OUT marker (contracts/agent-ingest.md). */
public record MarkerDto(
        @NotBlank @Size(max = 200) String callId,
        @Min(0) int seq,
        @NotNull MarkerType type,
        @Size(max = 64) String at,
        @Size(max = 20) String method,
        @Size(max = 4000) String url
) {
    public CallMarker toDomain() {
        return new CallMarker(callId, seq, type, at, method, url);
    }
}
