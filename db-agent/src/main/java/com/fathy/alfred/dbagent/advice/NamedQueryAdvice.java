package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** createNamedQuery/getNamedQuery: remembers the name of the query object it returns. */
public final class NamedQueryAdvice {

    private NamedQueryAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.Argument(0) String name, @Advice.Return(typing = Assigner.Typing.DYNAMIC) Object query) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null && query != null) {
            d.queryNamed(query, name);
        }
    }
}
