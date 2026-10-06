package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.redisson.Redisson;
import org.redisson.api.RedissonClient;
import org.redisson.client.codec.StringCodec;
import org.redisson.config.Config;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.Pipeline;
import redis.clients.jedis.Transaction;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Value before a write (T064, FR-024): opt-in, read through the client before the write, never inside a transaction
 * or pipeline (the reason is recorded), nothing extra sent when off, and the application's results unchanged.
 */
class RedisBeforeImageIT {

    static MiniRedis redis;

    @BeforeAll
    static void start() throws Exception {
        redis = new MiniRedis();
    }

    @AfterAll
    static void stop() throws Exception {
        redis.close();
    }

    @BeforeEach
    void reset() {
        AgentTestSupport.reset();
        redis.reset();
    }

    private static String text(byte[] b) {
        return b == null ? null : new String(b, StandardCharsets.UTF_8);
    }

    @Test
    void offSendsNothingExtra() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=bi-off; db=0; redis=1", () -> jedis.incr("c"));
            assertThat(SINK.awaitRedis("bi-off", 1).get(0).before).isNull();
            assertThat(redis.commandNames()).doesNotContain("TYPE", "PTTL");
        }
    }

    @Test
    void jedisWritesShowWhatTheKeyHeldBefore() throws Exception {
        SETTINGS.applyRedis(true, false);
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            jedis.set("rate:org:948:upsell", "37");
            jedis.expire("rate:org:948:upsell", 100);
            jedis.hset("user:790:prefs", "currency", "AED");
            final long[] result = new long[1];
            AgentTestSupport.inCall("id=bi-jd; db=0; redis=1", () -> {
                result[0] = jedis.incr("rate:org:948:upsell");
                jedis.set("upsell:new", "x");
                jedis.hset("user:790:prefs", "language", "en");
                jedis.expire("rate:org:948:upsell", 60);
            });
            assertThat(result[0]).isEqualTo(38); // the application's own result is unchanged
            List<RedisCommandRecord> r = SINK.awaitRedis("bi-jd", 4);
            assertThat(r).extracting(x -> x.command).containsExactly("INCR", "SET", "HSET", "EXPIRE");
            assertThat(text(r.get(0).before)).isEqualTo("$2\r\n37\r\n");
            assertThat(r.get(0).beforeNote).startsWith("type string");
            assertThat(r.get(1).beforeNote).isEqualTo("(nil) - new key");
            assertThat(text(r.get(2).before)).contains("currency").contains("AED");
            assertThat(r.get(3).beforeNote).startsWith("ttl ");
        }
    }

    @Test
    void neverInsideATransactionOrPipeline() throws Exception {
        SETTINGS.applyRedis(true, false);
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=bi-tx; db=0; redis=1", () -> {
                Transaction t = jedis.multi();
                t.incr("c");
                t.exec();
                Pipeline p = jedis.pipelined();
                p.set("p1", "1");
                p.set("p2", "2");
                p.sync();
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("bi-tx", 5);
            assertThat(r.get(1).command).isEqualTo("INCR");
            assertThat(r.get(1).beforeNote).isEqualTo("not read (in a transaction)");
            assertThat(r.get(4).beforeNote).isEqualTo("not read (in a pipeline)");
            assertThat(r.get(1).before).isNull();
        }
    }

    @Test
    void lettuceAndRedissonReadThroughTheirOwnConnection() throws Exception {
        SETTINGS.applyRedis(true, false);
        RedisClient client = RedisClient.create(redis.uri());
        Config config = new Config();
        config.useSingleServer().setAddress("redis://127.0.0.1:" + redis.port()).setConnectionMinimumIdleSize(1)
                .setConnectionPoolSize(2).setPingConnectionInterval(0).setSubscriptionConnectionMinimumIdleSize(0);
        config.setCodec(StringCodec.INSTANCE);
        RedissonClient redisson = Redisson.create(config);
        try (StatefulRedisConnection<String, String> c = client.connect()) {
            c.sync().set("lt:k", "old");
            redisson.getBucket("rs:k").set("old");
            AgentTestSupport.inCall("id=bi-lt; db=0; redis=1", () -> {
                c.sync().set("lt:k", "new");
                redisson.getBucket("rs:k").set("new");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("bi-lt", 2);
            assertThat(r).extracting(x -> x.command).containsExactly("SET", "SET");
            assertThat(r.get(0).beforeNote + " / " + text(r.get(0).before)).isEqualTo("type string · no ttl / $3\r\nold\r\n");
            assertThat(r.get(1).beforeNote + " / " + text(r.get(1).before)).isEqualTo("type string · no ttl / $3\r\nold\r\n");
            assertThat(c.sync().get("lt:k")).isEqualTo("new");
        } finally {
            client.shutdown(0, 1, TimeUnit.SECONDS);
            redisson.shutdown(0, 1, TimeUnit.SECONDS);
        }
    }
}
