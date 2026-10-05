package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Connection.setAutoCommit: transaction bookkeeping, and how long beginning one (auto-commit off) took. */
public final class AutoCommitAdvice {

    private AutoCommitAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static long enter(@Advice.This Object connection, @Advice.Argument(0) boolean autoCommit) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.autoCommit(connection, autoCommit);
        }
        return System.nanoTime();
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.This Object connection, @Advice.Argument(0) boolean autoCommit, @Advice.Enter long start) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null && !autoCommit) {
            d.autoCommitDone(connection, System.nanoTime() - start);
        }
    }
}
