package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** JedisPool.getResource / commons-pool2 GenericObjectPool.borrowObject: how long the application waited for a connection. */
public final class RedisPoolAdvice {

    private RedisPoolAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object pool) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisPoolEnter(pool);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object resource) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisPoolExit(token, resource);
            }
        }
    }
}
