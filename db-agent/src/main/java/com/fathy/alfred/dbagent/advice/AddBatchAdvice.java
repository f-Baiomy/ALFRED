package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** addBatch(): the current parameters (or the SQL, for Statement.addBatch(sql)) become a batch set. */
public final class AddBatchAdvice {

    private AddBatchAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object statement, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.addBatch(statement, args);
        }
    }
}
