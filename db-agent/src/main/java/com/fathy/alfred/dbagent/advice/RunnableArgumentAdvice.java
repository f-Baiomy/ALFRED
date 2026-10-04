package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Inlined into thread pools' execute/submit/schedule: the task keeps the submitting thread's call. */
public final class RunnableArgumentAdvice {

    private RunnableArgumentAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.Argument(value = 0, readOnly = false, typing = Assigner.Typing.DYNAMIC) Object task) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            task = d.wrapRunnable(task);
        }
    }
}
