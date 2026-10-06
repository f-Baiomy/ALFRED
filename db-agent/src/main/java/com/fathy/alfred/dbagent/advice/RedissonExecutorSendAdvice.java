package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Redisson RedisExecutor.sendCommand - may run on a Netty thread once a connection is free: the executor's call is made
 *  current for the CommandData created inside. */
public final class RedissonExecutorSendAdvice {

    private RedissonExecutorSendAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object executor, @Advice.Argument(1) Object connection) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisExecutorSendEnter(executor, connection);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisExecutorSendExit(token);
            }
        }
    }
}
