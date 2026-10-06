package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.redisson.Redisson;
import org.redisson.api.RBatch;
import org.redisson.api.RBucket;
import org.redisson.api.RedissonClient;
import org.redisson.client.codec.StringCodec;
import org.redisson.config.Config;

import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Redisson through the real agent against {@link MiniRedis} (specs/011-redis-capture T027): commands created on the
 * application's thread or on a Netty thread once a connection is free are attributed through their RedisExecutor.
 */
class RedisCaptureRedissonIT {

    static MiniRedis redis;
    static RedissonClient client;

    @BeforeAll
    static void start() throws Exception {
        AgentTestSupport.reset();
        redis = new MiniRedis();
        Config config = new Config();
        config.useSingleServer().setAddress("redis://127.0.0.1:" + redis.port())
                .setConnectionMinimumIdleSize(1).setConnectionPoolSize(2).setPingConnectionInterval(0)
                .setSubscriptionConnectionMinimumIdleSize(0).setSubscriptionConnectionPoolSize(1);
        config.setCodec(StringCodec.INSTANCE);
        client = Redisson.create(config);
    }

    @AfterAll
    static void stop() throws Exception {
        client.shutdown(0, 1, TimeUnit.SECONDS);
        redis.close();
    }

    @BeforeEach
    void reset() {
        AgentTestSupport.reset();
        redis.reset();
    }

    private static List<String> names(List<RedisCommandRecord> records) {
        return records.stream().map(r -> r.command).collect(Collectors.toList());
    }

    @Test
    void bucketCommandsAreRecordedWithExactBytes() throws Exception {
        RBucket<String> bucket = client.getBucket("cache:prefer-airline:948");
        AgentTestSupport.inCall("id=rs-plain; db=0; redis=1", () -> {
            bucket.set("[]");
            bucket.get();
            client.getBucket("missing").get();
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("rs-plain", 3);
        assertThat(names(r)).containsExactly("SET", "GET", "GET");
        assertThat(r.get(0).keys).containsExactly("cache:prefer-airline:948");
        assertThat(r.get(1).replyType).isEqualTo("BULK");
        assertThat(r.get(2).replyType).isEqualTo("NIL");
        assertThat(r.get(0).client).startsWith("redisson");
        assertThat(r.get(0).code).contains("RedisCaptureRedissonIT");
    }

    @Test
    void asyncCommandsStayWithTheirCall() throws Exception {
        AgentTestSupport.inCall("id=rs-async; db=0; redis=1", () -> {
            client.getBucket("a").setAsync("1").toCompletableFuture().get(2, TimeUnit.SECONDS);
            client.getBucket("a").getAsync().toCompletableFuture().get(2, TimeUnit.SECONDS);
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("rs-async", 2);
        assertThat(names(r)).containsExactly("SET", "GET");
    }

    @Test
    void aBatchIsRecordedCommandByCommand() throws Exception {
        AgentTestSupport.inCall("id=rs-batch; db=0; redis=1", () -> {
            RBatch batch = client.createBatch();
            batch.getBucket("b1").setAsync("1");
            batch.getBucket("b2").setAsync("2");
            batch.execute();
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("rs-batch", 2);
        assertThat(names(r)).contains("SET");
        assertThat(r.stream().filter(x -> x.command.equals("SET")).count()).isEqualTo(2);
    }

    @Test
    void errorRepliesAreRecorded() throws Exception {
        AgentTestSupport.inCall("id=rs-err; db=0; redis=1", () -> {
            try {
                client.getScript(StringCodec.INSTANCE).evalSha(org.redisson.api.RScript.Mode.READ_WRITE, "3f1c9ea2",
                        org.redisson.api.RScript.ReturnType.INTEGER, java.util.Collections.singletonList("lock:upsell:948"));
            } catch (Exception expected) {
                // NOSCRIPT
            }
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("rs-err", 1);
        assertThat(r).isNotEmpty();
        assertThat(r.get(0).command).isEqualTo("EVALSHA");
        assertThat(r.get(0).replyType).isEqualTo("ERROR");
    }
}
