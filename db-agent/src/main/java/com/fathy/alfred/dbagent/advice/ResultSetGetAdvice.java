package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** ResultSet get*(index|label): the value the application just read. */
public final class ResultSetGetAdvice {

    private ResultSetGetAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object resultSet, @Advice.Origin("#m") String method, @Advice.AllArguments Object[] args,
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object value) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.resultSetGet(resultSet, method, args, value);
        }
    }
}
