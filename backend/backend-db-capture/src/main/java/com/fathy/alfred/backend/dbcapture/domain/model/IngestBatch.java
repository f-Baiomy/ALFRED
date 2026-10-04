package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;
import java.util.Map;

/** One POST from an agent: its statements, its call markers, and how many statements it had to drop per call. */
public record IngestBatch(String agentId, String project, List<IncomingStatement> statements, List<CallMarker> markers,
                          Map<String, Long> droppedByCall) {
}
