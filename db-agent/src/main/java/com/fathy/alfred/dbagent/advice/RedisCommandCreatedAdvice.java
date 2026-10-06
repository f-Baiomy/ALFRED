package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Lettuce DefaultEndpoint.write(RedisCommand|Collection) - still on the application's thread, so the command is
 *  attributed to the call here (specs/011-redis-capture, research R1/R2). */
public final class RedisCommandCreatedAdvice {

    private RedisCommandCreatedAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static void enter(@Advice.This Object endpoint, @Advice.Argument(0) Object command) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        if (d != null) {
            d.redisCommandCreated("lettuce", command, endpoint);
        }
    }
}
