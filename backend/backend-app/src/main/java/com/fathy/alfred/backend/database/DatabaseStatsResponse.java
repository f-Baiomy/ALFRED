package com.fathy.alfred.backend.database;

import com.fathy.alfred.backend.calls.domain.model.CallStatusBreakdown;

import java.util.List;

/** GET /database/stats response - the Database settings tab's whole payload. */
public record DatabaseStatsResponse(CallStatusBreakdown calls, List<DatabaseFileStats> files) {
}
