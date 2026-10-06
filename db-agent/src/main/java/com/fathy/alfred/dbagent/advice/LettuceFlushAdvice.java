package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Lettuce DefaultEndpoint.flushCommands: commands queued while auto-flush was off go out - a pipeline ends. */
public final class LettuceFlushAdvice {

    private LettuceFlushAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object endpoint) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisFlush(endpoint);
        }
    }
}
