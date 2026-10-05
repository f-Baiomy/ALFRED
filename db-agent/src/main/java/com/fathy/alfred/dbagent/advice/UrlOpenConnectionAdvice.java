package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/**
 * java.net.URL.openConnection: an HTTP(S) connection gets X-Alfred-Parent the moment it exists. Adding it later, in
 * connect/getOutputStream, is too late for some client code - the JDK refuses a header once the connection is
 * connecting, and the supplier call was then logged without its parent (odeysys' NDC client).
 */
public final class UrlOpenConnectionAdvice {

    private UrlOpenConnectionAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.Return(typing = Assigner.Typing.DYNAMIC) Object connection) {
        if (connection instanceof java.net.HttpURLConnection) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.outboundOpened(connection);
            }
        }
    }
}
