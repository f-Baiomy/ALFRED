package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** A CallableStatement get* after execute: an OUT parameter value as the application read it. */
public final class OutParameterAdvice {

    private OutParameterAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object statement, @Advice.AllArguments Object[] args,
                            @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object value) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.outParameterRead(statement, args, value);
        }
    }
}
