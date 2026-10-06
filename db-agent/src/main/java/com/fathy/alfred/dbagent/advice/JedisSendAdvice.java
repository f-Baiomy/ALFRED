package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Jedis Connection.sendCommand(ProtocolCommand, byte[]...) and sendCommand(CommandArguments): the root of every command
 *  Jedis 3, 4 and 5 sends. One overload calls the other in some versions; the dispatcher records the outermost. */
public final class JedisSendAdvice {

    private JedisSendAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object connection, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisJedisSend(connection, args.length > 0 ? args[0] : null, args.length > 1 ? args[1] : null);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token, @Advice.Thrown Throwable thrown) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisJedisSendExit(token, thrown);
            }
        }
    }
}
