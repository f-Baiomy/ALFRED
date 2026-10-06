package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/**
 * Inlined into each logging framework's dispatch point (specs/009-agent-log-capture, research R1): the event, after
 * the application's own level check, on its way to the handlers/appenders. The declaring type names the framework.
 * Enter returns a token only at the outermost hook on the thread, so bridged events are caught once (R2).
 */
public final class LogEventAdvice {

    private LogEventAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object self, @Advice.Argument(0) Object event, @Advice.Origin("#t") String type) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.logEnter(type, self, event);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.logExit(token);
            }
        }
    }
}
