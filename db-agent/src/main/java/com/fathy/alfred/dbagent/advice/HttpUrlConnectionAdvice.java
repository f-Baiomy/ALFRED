package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** The JDK HttpURLConnection, before it connects: add X-Alfred-Parent (inside a captured call only). */
public final class HttpUrlConnectionAdvice {

    private HttpUrlConnectionAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object self) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d == null) {
            return;
        }
        java.net.HttpURLConnection connection = (java.net.HttpURLConnection) self;
        // Throws IllegalStateException once connected - which is exactly when there is nothing left to add.
        if (connection.getRequestProperty("X-Alfred-Parent") == null) {
            String header = d.outboundHeader(connection.getRequestMethod(), connection.getURL().toString());
            if (header != null) {
                connection.setRequestProperty("X-Alfred-Parent", header);
            }
        }
    }
}
