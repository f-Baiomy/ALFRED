package org.springframework.cache.interceptor;

import java.lang.reflect.Method;
import java.util.function.Supplier;

/**
 * Test stand-in for Spring's CacheAspectSupport (specs/011-redis-capture, RedisSpringCacheIT): the agent hooks
 * {@code execute(invoker, target, method, args)} by name only, so this is all it needs to see.
 */
public class CacheAspectSupport {

    public Object execute(Object invoker, Object target, Method method, Object[] args) {
        @SuppressWarnings("unchecked")
        Supplier<Object> body = (Supplier<Object>) invoker;
        return body.get();
    }
}
