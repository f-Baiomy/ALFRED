package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Redisson CommandDecoder.decode(ByteBuf, CommandData, List, Channel, boolean, List) - one reply; it recurses for the
 *  elements of a list reply, and only the outermost call on the thread records (the dispatcher keeps the depth). */
public final class RedissonDecodeAdvice {

    private RedissonDecodeAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.Argument(0) Object buffer, @Advice.Argument(1) Object command) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisDecodeEnter("redisson", command, buffer);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisDecodeExit(token, true, thrown);
            }
        }
    }
}
