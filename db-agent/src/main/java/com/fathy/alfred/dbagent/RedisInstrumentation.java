package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.advice.JedisFillAdvice;
import com.fathy.alfred.dbagent.advice.JedisReplyAdvice;
import com.fathy.alfred.dbagent.advice.JedisSendAdvice;
import com.fathy.alfred.dbagent.advice.LettuceAutoFlushAdvice;
import com.fathy.alfred.dbagent.advice.LettuceDecodeAdvice;
import com.fathy.alfred.dbagent.advice.LettuceFlushAdvice;
import com.fathy.alfred.dbagent.advice.RedisCommandCreatedAdvice;
import com.fathy.alfred.dbagent.advice.RedisEncodeAdvice;
import com.fathy.alfred.dbagent.advice.RedisPoolAdvice;
import com.fathy.alfred.dbagent.advice.RedissonCommandDataAdvice;
import com.fathy.alfred.dbagent.advice.RedissonDecodeAdvice;
import com.fathy.alfred.dbagent.advice.RedissonExecutorCreatedAdvice;
import com.fathy.alfred.dbagent.advice.RedissonExecutorSendAdvice;
import com.fathy.alfred.dbagent.advice.SpringCacheAdvice;
import net.bytebuddy.agent.builder.AgentBuilder;

import static net.bytebuddy.matcher.ElementMatchers.isConstructor;
import static net.bytebuddy.matcher.ElementMatchers.named;
import static net.bytebuddy.matcher.ElementMatchers.namedOneOf;
import static net.bytebuddy.matcher.ElementMatchers.takesArgument;
import static net.bytebuddy.matcher.ElementMatchers.takesArguments;

/**
 * The Redis hooks (specs/011-redis-capture, research R1/R5/R6): one send point and one reply point per client - below
 * every API of that client, so sync, async, reactive, pipelined and Spring use are all seen - plus Spring Cache for the
 * origin and the pools for the wait. Matched by name: a client that is not on the class path is simply not hooked.
 */
final class RedisInstrumentation {

    private RedisInstrumentation() {
    }

    static AgentBuilder add(AgentBuilder builder) {
        // Lettuce 5/6
        builder = Instrumenter.advise(builder, named("io.lettuce.core.protocol.DefaultEndpoint"), RedisCommandCreatedAdvice.class,
                named("write").and(takesArguments(1)).and(takesArgument(0, namedOneOf("io.lettuce.core.protocol.RedisCommand", "java.util.Collection"))));
        builder = Instrumenter.advise(builder, named("io.lettuce.core.protocol.DefaultEndpoint"), LettuceAutoFlushAdvice.class,
                named("setAutoFlushCommands").and(takesArguments(1)));
        builder = Instrumenter.advise(builder, named("io.lettuce.core.protocol.DefaultEndpoint"), LettuceFlushAdvice.class,
                named("flushCommands").and(takesArguments(0)));
        builder = Instrumenter.advise(builder, named("io.lettuce.core.protocol.CommandEncoder"), RedisEncodeAdvice.class,
                named("encode").and(takesArguments(3)).and(takesArgument(1, Object.class)));
        builder = Instrumenter.advise(builder, named("io.lettuce.core.protocol.CommandHandler"), LettuceDecodeAdvice.class,
                named("decode").and(takesArguments(3)).and(takesArgument(1, named("io.lettuce.core.protocol.RedisCommand"))));

        // Jedis 3/4/5
        builder = Instrumenter.advise(builder, named("redis.clients.jedis.Connection"), JedisSendAdvice.class,
                named("sendCommand").and(takesArguments(1).and(takesArgument(0, named("redis.clients.jedis.CommandArguments")))
                        .or(takesArguments(2).and(takesArgument(1, byte[][].class)))));
        builder = Instrumenter.advise(builder, named("redis.clients.jedis.Connection"), JedisReplyAdvice.class,
                named("readProtocolWithCheckingBroken").and(takesArguments(0)));
        builder = Instrumenter.advise(builder, named("redis.clients.jedis.util.RedisInputStream").or(named("redis.clients.util.RedisInputStream")), JedisFillAdvice.class,
                named("ensureFill").and(takesArguments(0)));
        builder = Instrumenter.advise(builder, named("redis.clients.jedis.JedisPool").or(named("redis.clients.jedis.util.Pool")).or(named("redis.clients.util.Pool")),
                RedisPoolAdvice.class, named("getResource").and(takesArguments(0)));
        // commons-pool2 (Lettuce's ConnectionPoolSupport, Jedis 4/5's Pool): only a Redis connection handed out counts
        builder = Instrumenter.advise(builder, named("org.apache.commons.pool2.impl.GenericObjectPool"), RedisPoolAdvice.class,
                named("borrowObject").and(takesArguments(0).or(takesArguments(1))));

        // Redisson 3
        builder = Instrumenter.advise(builder, named("org.redisson.command.RedisExecutor"), RedissonExecutorCreatedAdvice.class, isConstructor());
        builder = Instrumenter.advise(builder, named("org.redisson.command.RedisExecutor"), RedissonExecutorSendAdvice.class,
                named("sendCommand").and(takesArguments(2)));
        builder = Instrumenter.advise(builder, named("org.redisson.client.protocol.CommandData"), RedissonCommandDataAdvice.class, isConstructor());
        builder = Instrumenter.advise(builder, named("org.redisson.client.handler.CommandEncoder"), RedisEncodeAdvice.class,
                named("encode").and(takesArguments(3)).and(takesArgument(1, named("org.redisson.client.protocol.CommandData"))));
        builder = Instrumenter.advise(builder, named("org.redisson.client.handler.CommandDecoder"), RedissonDecodeAdvice.class,
                named("decode").and(takesArguments(6)).and(takesArgument(1, named("org.redisson.client.protocol.CommandData"))));

        // Spring Cache: which cache and method a command is for
        builder = Instrumenter.advise(builder, named("org.springframework.cache.interceptor.CacheAspectSupport"), SpringCacheAdvice.class,
                named("execute").and(takesArguments(4)));
        builder = Instrumenter.advise(builder, named("org.springframework.data.redis.cache.RedisCache"), SpringCacheAdvice.class,
                namedOneOf("lookup", "put", "putIfAbsent", "evict", "evictIfPresent", "clear", "invalidate", "retrieve"));
        return builder;
    }
}
