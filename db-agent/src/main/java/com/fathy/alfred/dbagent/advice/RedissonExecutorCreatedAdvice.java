package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Redisson RedisExecutor constructor - on the application's thread: remembers the call for its later sends. */
public final class RedissonExecutorCreatedAdvice {

    private RedissonExecutorCreatedAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class) // constructors: an exception cannot be caught around one
    public static void exit(@Advice.This Object executor) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisExecutorCreated(executor);
        }
    }
}
