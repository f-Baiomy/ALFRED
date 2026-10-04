package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Connection.setAutoCommit: transaction tracking. */
public final class AutoCommitAdvice {

    private AutoCommitAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object connection, @Advice.Argument(0) boolean autoCommit) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.autoCommit(connection, autoCommit);
        }
    }
}
