package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** ResultSet.next(): a row starts (true) or the result ended (false). */
public final class ResultSetNextAdvice {

    private ResultSetNextAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object resultSet, @Advice.Return boolean hasRow) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.resultSetNext(resultSet, hasRow);
        }
    }
}
