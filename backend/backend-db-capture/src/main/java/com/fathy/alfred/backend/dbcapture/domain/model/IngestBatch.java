package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;
import java.util.Map;

/** One POST from an agent: its statements, its call markers, and how many statements it had to drop per call. */
public record IngestBatch(String agentId, String project, List<IncomingStatement> statements, List<CallMarker> markers,
                          Map<String, Long> droppedByCall, List<CaughtLogLine> logs, Map<String, Long> droppedLogs,
                          List<RedisIn> redis, List<IncomingStoreChunk> redisChunks, Map<String, Long> droppedRedis) {

    /** A Redis command as it arrived (specs/011-redis-capture): {@code invalid} says why it could not be read whole. */
    public record RedisIn(IncomingStoreCommand command, String invalid) {
    }

    public IngestBatch(String agentId, String project, List<IncomingStatement> statements, List<CallMarker> markers,
                       Map<String, Long> droppedByCall, List<CaughtLogLine> logs, Map<String, Long> droppedLogs) {
        this(agentId, project, statements, markers, droppedByCall, logs, droppedLogs, List.of(), List.of(), Map.of());
    }

    public IngestBatch(String agentId, String project, List<IncomingStatement> statements, List<CallMarker> markers,
                       Map<String, Long> droppedByCall) {
        this(agentId, project, statements, markers, droppedByCall, List.of(), Map.of());
    }
}
