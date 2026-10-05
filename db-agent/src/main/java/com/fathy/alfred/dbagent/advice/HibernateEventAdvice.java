package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** A Hibernate event that makes SQL without a query of the code's: a collection initialised, an entity loaded, a
 *  flush, and each action a flush executes. */
public final class HibernateEventAdvice {

    private HibernateEventAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object self, @Advice.Origin("#t") String type, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.hibernateEventEnter(type, self, args);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.originExit(token);
            }
        }
    }
}
