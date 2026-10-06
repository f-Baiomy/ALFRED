package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Redisson CommandData constructors: a command exists - attributed to the call, or to its RedisExecutor's call. */
public final class RedissonCommandDataAdvice {

    private RedissonCommandDataAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class) // constructors: an exception cannot be caught around one
    public static void exit(@Advice.This Object command) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisCommandCreated("redisson", command, null);
        }
    }
}
