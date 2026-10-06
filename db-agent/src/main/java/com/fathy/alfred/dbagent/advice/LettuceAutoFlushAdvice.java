package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Lettuce DefaultEndpoint.setAutoFlushCommands(boolean): false = the application pipelines until flushCommands. */
public final class LettuceAutoFlushAdvice {

    private LettuceAutoFlushAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object endpoint, @Advice.Argument(0) boolean on) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisAutoFlush(endpoint, on);
        }
    }
}
