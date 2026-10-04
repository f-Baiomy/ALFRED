package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** PreparedStatement/CallableStatement set* and registerOutParameter: record the bound value. */
public final class ParameterAdvice {

    private ParameterAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object statement, @Advice.Origin("#m") String method, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.parameter(statement, method, args);
        }
    }
}
