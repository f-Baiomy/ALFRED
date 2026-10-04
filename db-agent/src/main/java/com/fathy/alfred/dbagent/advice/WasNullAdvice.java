package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;
import net.bytebuddy.implementation.bytecode.assign.Assigner;

/** ResultSet.wasNull(): the last primitive read was really SQL NULL. */
public final class WasNullAdvice {

    private WasNullAdvice() {
    }

    @Advice.OnMethodExit(suppress = Throwable.class)
    public static void exit(@Advice.This Object resultSet, @Advice.Return boolean wasNull) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.resultSetWasNull(resultSet, wasNull);
        }
    }
}
