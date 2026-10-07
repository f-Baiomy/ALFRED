package com.fathy.alfred.dbagent.transport;

/** Where captured records go - the BatchSender in the agent, a list in the tests. Must never block or throw. */
public interface StatementSink {

    void statement(StatementRecord record);

    void marker(MarkerRecord marker);

    /**
     * The reverse proxy said where Alfred is ({@code alfred=}/{@code key=} in X-Alfred-Call): report there from now
     * on. Called on every stamped request, so it must be a cheap comparison when nothing changed.
     */
    default void follow(String url, String key) {
    }

    /** A caught log line (specs/009-agent-log-capture). */
    default void log(LogRecord record) {
    }

    /** Lines of a call that were not kept (caps, late) - counted, sent with the next batch. */
    default void droppedLogs(String callId, int count) {
    }

    /**
     * A Redis command (specs/011-redis-capture) with the parts of its bytes when it was too big for one record. Kept
     * whole or not at all: when any part cannot be queued, nothing of it is, and the call's drop count grows.
     */
    default void redis(RedisCommandRecord record, java.util.List<RedisChunkRecord> chunks) {
    }
}
