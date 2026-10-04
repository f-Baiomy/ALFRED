package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** getResultSet()/getGeneratedKeys(): link the result set to the statement that produced it. */
public final class ResultSetOpenedAdvice {

    private ResultSetOpenedAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object statement, @Advice.Origin("#m") String method,
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object resultSet) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null && resultSet != null) {
            d.resultSetOpened(statement, resultSet, method);
        }
    }
}
