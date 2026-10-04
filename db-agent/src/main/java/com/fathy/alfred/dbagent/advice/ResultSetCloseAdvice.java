package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** ResultSet.close(): the statement is finished with what the application read. */
public final class ResultSetCloseAdvice {

    private ResultSetCloseAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object resultSet) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.resultSetClosed(resultSet);
        }
    }
}
