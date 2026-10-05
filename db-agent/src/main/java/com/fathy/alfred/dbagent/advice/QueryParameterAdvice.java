package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** setParameter/setParameterList/typed setters and setFirstResult/setMaxResults on a Hibernate/JPA query. */
public final class QueryParameterAdvice {

    private QueryParameterAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object query, @Advice.Origin("#m") String method, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.queryParameter(query, method, args);
        }
    }
}
