package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Jedis RedisInputStream.ensureFill: before the buffer is refilled, the reply bytes read from it so far are kept. */
public final class JedisFillAdvice {

    private JedisFillAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object stream) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisJedisFill(stream);
        }
    }
}
