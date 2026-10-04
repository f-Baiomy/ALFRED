package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Same as RunnableArgumentAdvice, for Callable tasks. */
public final class CallableArgumentAdvice {

    private CallableArgumentAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.Argument(value = 0, readOnly = false, typing = Assigner.Typing.DYNAMIC) Object task) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            task = d.wrapCallable(task);
        }
    }
}
