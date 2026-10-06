package com.fathy.alfred.dbagent.advice;

import com.fathy.alfred.dbagent.bootstrap.Bridge;
import net.bytebuddy.asm.Advice;

/** Spring Cache: CacheAspectSupport.execute(invoker, target, method, args) and RedisCache's lookup/put/putIfAbsent/evict/
 *  clear/get - the cache and method a Redis command was sent for (specs/011-redis-capture, research R5). */
public final class SpringCacheAdvice {

    private SpringCacheAdvice() {
    }

    @Advice.OnMethodEnter(suppress = Throwable.class)
    public static Object enter(@Advice.This Object self, @Advice.Origin("#t") String type, @Advice.Origin("#m") String method, @Advice.AllArguments Object[] args) {
        Bridge.Dispatcher d = Bridge.dispatcher;
        return d == null ? null : d.redisOriginEnter(type.endsWith("CacheAspectSupport") ? "aspect" : method, self, args);
    }

    @Advice.OnMethodExit(onThrowable = Throwable.class, suppress = Throwable.class)
    public static void exit(@Advice.Enter Object token) {
        if (token != null) {
            Bridge.Dispatcher d = Bridge.dispatcher;
            if (d != null) {
                d.redisOriginExit(token);
            }
        }
    }
}
