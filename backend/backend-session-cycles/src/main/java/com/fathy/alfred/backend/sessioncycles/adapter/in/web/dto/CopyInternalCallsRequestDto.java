package com.fathy.alfred.backend.sessioncycles.adapter.in.web.dto;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/** Web-layer input for POST /session-cycles/{id}/internal-calls/copy - mirrors CopyCallsRequestDto, typed to backend-internal-calls' CallRecord instead. */
public record CopyInternalCallsRequestDto(
        @NotEmpty List<CallRecord> calls
) {
}
