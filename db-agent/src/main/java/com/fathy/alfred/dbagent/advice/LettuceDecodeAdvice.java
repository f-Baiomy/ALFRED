package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Lettuce CommandHandler.decode(ByteBuf, RedisCommand, CommandOutput): the reader index before and after bounds the
 *  reply bytes consumed; it returns true once the command's reply is complete (research R1). */
public final class LettuceDecodeAdvice {

    private LettuceDecodeAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.Argument(0) Object buffer, @Advice.Argument(1) Object command) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisDecodeEnter("lettuce", command, buffer);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Return boolean done, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisDecodeExit(token, done, thrown);
            }
        }
    }
}
