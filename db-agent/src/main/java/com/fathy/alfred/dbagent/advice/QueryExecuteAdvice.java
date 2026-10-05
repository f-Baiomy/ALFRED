package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** A Hibernate/JPA query runs (list, getResultList, uniqueResult, executeUpdate, scroll ...): every statement executed
 *  until it returns is tagged with the query the code wrote. */
public final class QueryExecuteAdvice {

    private QueryExecuteAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object query, @Advice.Origin("#m") String method) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.queryEnter(query, method);
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
