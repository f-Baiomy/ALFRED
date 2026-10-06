package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.Pipeline;
import redis.clients.jedis.Transaction;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Jedis through the real agent against {@link MiniRedis} (specs/011-redis-capture T026): commands matched to replies in
 * order per connection, reply bytes read exactly off the input stream, pipelines and transactions grouped.
 */
class RedisCaptureJedisIT {

    static MiniRedis redis;

    @BeforeAll
    static void start() throws Exception {
        AgentTestSupport.reset();
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

    private static List<String> names(List<RedisCommandRecord> records) {
        return records.stream().map(r -> r.command).collect(Collectors.toList());
    }

    @Test
    void commandsAndTheirExactReplyBytes() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            jedis.ping(); // outside the call: nothing recorded
            AgentTestSupport.inCall("id=jd-plain; db=0; redis=1", () -> {
                jedis.set("session:odeysys:9f2a41c7", "abc");
                jedis.get("session:odeysys:9f2a41c7");
                jedis.get("missing");
                jedis.incr("rate:org:948:upsell");
                jedis.hset("user:790:prefs", "currency", "AED");
                jedis.hgetAll("user:790:prefs");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("jd-plain", 6);
            assertThat(names(r)).containsExactly("SET", "GET", "GET", "INCR", "HSET", "HGETALL");
            assertThat(r.get(0).replyType).isEqualTo("SIMPLE");
            assertThat(new String(r.get(0).reply, StandardCharsets.UTF_8)).isEqualTo("+OK\r\n"); // a status, not a bulk
            assertThat(r.get(2).replyType).isEqualTo("NIL");
            assertThat(r.get(5).replyType).isEqualTo("ARRAY");
            // every reply equals the bytes the server wrote, in order
            List<byte[]> server = redis.replies;
            for (int i = 0; i < r.size(); i++) {
                assertThat(r.get(i).reply).isEqualTo(server.get(server.size() - r.size() + i));
            }
            assertThat(r.get(0).client).startsWith("jedis");
            assertThat(r.get(0).server).endsWith(":" + redis.port());
            assertThat(r.get(0).code).contains("RedisCaptureJedisIT");
            assertThat(new String(r.get(0).args, StandardCharsets.UTF_8)).startsWith("*3\r\n$3\r\nSET\r\n");
        }
    }

    @Test
    void aPipelineIsOneGroupAndATransactionAnother() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=jd-groups; db=0; redis=1", () -> {
                Pipeline p = jedis.pipelined();
                p.set("p1", "1");
                p.set("p2", "2");
                p.get("p1");
                p.sync();
                Transaction t = jedis.multi();
                t.incr("c");
                t.expire("c", 60);
                t.exec();
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("jd-groups", 7);
            assertThat(names(r)).containsExactly("SET", "SET", "GET", "MULTI", "INCR", "EXPIRE", "EXEC");
            assertThat(r.subList(0, 3)).extracting(x -> x.groupKind).containsOnly("pipeline");
            assertThat(r.subList(0, 3)).extracting(x -> x.groupSize).containsOnly(3);
            assertThat(r.subList(3, 7)).extracting(x -> x.groupKind).containsOnly("tx");
            assertThat(r.subList(3, 7)).extracting(x -> x.groupSize).containsOnly(4);
        }
    }

    @Test
    void pooledConnectionsRecordTheWait() throws Exception {
        try (JedisPool pool = new JedisPool("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=jd-pool; db=0; redis=1", () -> {
                try (Jedis jedis = pool.getResource()) {
                    jedis.set("k", "v");
                }
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("jd-pool", 1);
            assertThat(r.get(0).poolWaitMicros).isGreaterThanOrEqualTo(0);
        }
    }

    @Test
    void workerThreadsBlockingWaitsAndManyKeys() throws Exception {
        try (JedisPool pool = new JedisPool("127.0.0.1", redis.port())) {
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                AgentTestSupport.inCall("id=jd-misc; db=0; redis=1", () -> {
                    worker.submit(() -> {
                        try (Jedis j = pool.getResource()) {
                            j.set("from:worker", "1");
                        }
                    }).get(2, TimeUnit.SECONDS);
                    try (Jedis j = pool.getResource()) {
                        j.rpush("queue:jobs", "j1");
                        j.blpop(5, "queue:jobs");
                        List<String> kv = new ArrayList<>();
                        for (int i = 0; i < 100; i++) {
                            kv.add("k:" + i);
                            kv.add("v" + i);
                        }
                        j.mset(kv.toArray(new String[0]));
                    }
                });
            } finally {
                worker.shutdown();
            }
            List<RedisCommandRecord> r = SINK.awaitRedis("jd-misc", 4);
            assertThat(names(r)).containsExactly("SET", "RPUSH", "BLPOP", "MSET");
            assertThat(r.get(2).micros).isGreaterThanOrEqualTo(250_000);
            assertThat(r.get(3).keysTotal).isEqualTo(100);
            assertThat(r.get(3).keys).hasSize(64);
            assertThat(new String(r.get(3).args, StandardCharsets.UTF_8)).contains("k:99");
        }
    }

    @Test
    void errorRepliesAreRecordedAndTheNextReplyStaysMatched() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=jd-err; db=0; redis=1", () -> {
                try {
                    jedis.evalsha("3f1c9ea2", 1, "lock:upsell:948");
                } catch (Exception expected) {
                    // NOSCRIPT
                }
                jedis.eval("return 1", 1, "lock:upsell:948");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("jd-err", 2);
            assertThat(names(r)).containsExactly("EVALSHA", "EVAL");
            assertThat(r.get(0).replyType).isEqualTo("ERROR");
            assertThat(r.get(0).error).startsWith("NOSCRIPT");
            assertThat(r.get(1).replyType).isEqualTo("INTEGER");
        }
    }

    @Test
    void aLostConnectionIsAFailedCommandWithoutReply() throws Exception {
        MiniRedis doomed = new MiniRedis();
        Jedis jedis = new Jedis("127.0.0.1", doomed.port());
        jedis.ping();
        doomed.blpopDelayMillis = 2_000;
        AgentTestSupport.inCall("id=jd-lost; db=0; redis=1", () -> {
            Thread killer = new Thread(() -> {
                try {
                    Thread.sleep(200);
                    doomed.close(); // closes the server side of every connection too
                } catch (Exception ignored) {
                    // closing is the point
                }
            });
            killer.start();
            try {
                jedis.blpop(5, "never");
            } catch (Exception expected) {
                // connection lost
            }
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("jd-lost", 1);
        assertThat(r).hasSize(1);
        assertThat(r.get(0).error).isNotBlank();
        assertThat(r.get(0).replyType).isEqualTo("NONE");
    }
}
