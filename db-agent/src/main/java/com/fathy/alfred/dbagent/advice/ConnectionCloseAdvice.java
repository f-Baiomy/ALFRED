package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Connection.close: how long handing the connection back took (a pool may validate or roll back on return). */
public final class ConnectionCloseAdvice {

    private ConnectionCloseAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object connection) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.closeEnter(connection);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.closeExit(token);
            }
        }
    }
}
