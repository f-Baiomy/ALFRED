package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** Apache HttpClient 4/5 doExecute: tag the request (the dispatcher finds it among the arguments). */
public final class HttpClientAdvice {

    private HttpClientAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            for (Object arg : args) {
                d.tagHttpClientRequest(arg);
            }
        }
    }
}
