package com.fathy.alfred.dbagent.redis;

/**
 * The seam a later Relive version needs to answer a Redis command from a recording instead of sending it
 * (specs/011-redis-capture FR-052) - the same split as StatementInterceptor / CaptureOnlyInterceptor for JDBC. Called
 * with the agent's pending command when it is sent and when its reply is complete. This feature only records: the
 * shipped implementation is {@link CaptureOnlyRedisInterceptor}, and nothing changes what the application sends.
 */
public interface RedisInterceptor {

    /** A command of a captured call is about to be sent. */
    void onSend(Object pendingCommand);

    /** Its reply arrived - the exact RESP bytes. */
    void onReply(Object pendingCommand, byte[] reply);
}
