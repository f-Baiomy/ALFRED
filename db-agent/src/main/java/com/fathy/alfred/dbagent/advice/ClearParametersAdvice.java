package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** clearParameters(): forget the bound values. */
public final class ClearParametersAdvice {

    private ClearParametersAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object statement) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.clearParameters(statement);
        }
    }
}
