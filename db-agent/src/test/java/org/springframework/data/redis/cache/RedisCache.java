package org.springframework.data.redis.cache;

import java.util.function.Function;

/**
 * Test stand-in for Spring Data Redis's RedisCache (specs/011-redis-capture, RedisSpringCacheIT): a named cache whose
 * lookup/put run the given Redis operations - the agent reads {@code getName()} and the method hooked.
 */
public class RedisCache {

    private final String name;
    private final Function<Object, Object> reader;
    private final java.util.function.BiConsumer<Object, Object> writer;

    public RedisCache(String name, Function<Object, Object> reader, java.util.function.BiConsumer<Object, Object> writer) {
        this.name = name;
        this.reader = reader;
        this.writer = writer;
    }

    public String getName() {
        return name;
    }

    public Object lookup(Object key) {
        return reader.apply(key);
    }

    public void put(Object key, Object value) {
        writer.accept(key, value);
    }
}
