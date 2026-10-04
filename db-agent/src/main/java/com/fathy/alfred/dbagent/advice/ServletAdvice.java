package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Inlined into HttpServlet.service(HttpServletRequest, HttpServletResponse): opens and closes the call context. */
public final class ServletAdvice {

    private ServletAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.Argument(0) Object request) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.servletEnter(request);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.servletExit(token, thrown);
            }
        }
    }
}
