package com.fathy.alfred.dbagent.redis;

/** Records only - lets every command go to Redis unchanged (the only behaviour this feature ships). */
public final class CaptureOnlyRedisInterceptor implements RedisInterceptor {

    @Override
    public void onSend(Object pendingCommand) {
        // capture happens in the dispatcher; nothing is replaced
    }

    @Override
    public void onReply(Object pendingCommand, byte[] reply) {
        // the reply the application gets is the server's own
    }
}
