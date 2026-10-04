package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Statement.close(): finish its pending record. */
public final class StatementCloseAdvice {

    private StatementCloseAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object statement) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.statementClosed(statement);
        }
    }
}
