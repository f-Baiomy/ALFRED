package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Connection.prepareStatement/prepareCall/createStatement: remember the statement and its SQL. */
public final class StatementCreatedAdvice {

    private StatementCreatedAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object connection, @Advice.AllArguments Object[] args,
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object statement) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null && statement != null) {
            d.statementCreated(connection, statement, args.length > 0 && args[0] instanceof String ? (String) args[0] : null);
        }
    }
}
