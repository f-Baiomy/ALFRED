package com.alfred.pennyworth.sessioncycles.adapter.in.web.dto;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import jakarta.validation.constraints.NotEmpty;

import java.util.List;

/** Web-layer input for POST /session-cycles/{id}/calls/copy - CallRecord is reused directly since its wire shape and domain shape are identical (same rule GET /calls and POST /calls/webhook already follow). */
public record CopyCallsRequestDto(
        @NotEmpty List<CallRecord> calls
) {
}
