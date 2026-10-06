package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Lettuce and Redisson CommandEncoder.encode(ctx, msg, out): the bytes written into {@code out} between enter and exit
 *  are the command exactly as sent. The declaring type names the client. */
public final class RedisEncodeAdvice {

    private RedisEncodeAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.Argument(0) Object channelContext, @Advice.Argument(1) Object msg, @Advice.Argument(2) Object out, @Advice.Origin("#t") String type) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisEncodeEnter(type.startsWith("io.lettuce") ? "lettuce" : "redisson", channelContext, msg, out);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisEncodeExit(token);
            }
        }
    }
}
