package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** DataSource.getConnection: how long the pool took to hand a connection out (validation query included). */
public final class DataSourceAdvice {

    private DataSourceAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter() {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.acquireEnter();
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object connection) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.acquireExit(token, connection);
            }
        }
    }
}
