package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Jedis Connection.readProtocolWithCheckingBroken: one reply read off the connection (or the error it raised). The
 *  RedisInputStream bytes consumed in between are the exact reply (with the buffer refills seen by JedisFillAdvice). */
public final class JedisReplyAdvice {

    private JedisReplyAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object connection) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisJedisReadEnter(connection);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object result, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisJedisReply(token, result, thrown);
            }
        }
    }
}
