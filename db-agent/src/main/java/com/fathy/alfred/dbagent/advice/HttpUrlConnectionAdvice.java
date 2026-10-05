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
        // Once per connection: these methods run many times for one request (connect, getOutputStream, and
        // getInputStream behind every status/header read), and each time used to record another supplier call.
        String header = d.outboundHeaderFor(connection, connection.getRequestMethod(), connection.getURL().toString());
        if (header != null) {
            // Throws IllegalStateException once connected - which is exactly when there is nothing left to add.
            connection.setRequestProperty("X-Alfred-Parent", header);
        }
    }
}
