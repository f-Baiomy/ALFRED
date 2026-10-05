package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/**
 * JTA commit/rollback (javax and jakarta Transaction, TransactionManager, UserTransaction): a container-managed
 * transaction never calls Connection.commit - without this its JDBC transactions stayed "open" forever.
 */
public final class JtaAdvice {

    private JtaAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.Origin("#m") String method) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.jtaEnter(method);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.jtaExit(token, thrown);
            }
        }
    }
}
