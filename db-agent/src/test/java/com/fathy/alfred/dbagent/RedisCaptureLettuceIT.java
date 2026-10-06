package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import io.lettuce.core.RedisClient;
import io.lettuce.core.RedisFuture;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.async.RedisAsyncCommands;
import io.lettuce.core.api.sync.RedisCommands;
import io.lettuce.core.codec.ByteArrayCodec;
import io.lettuce.core.output.DoubleOutput;
import io.lettuce.core.protocol.CommandArgs;
import io.lettuce.core.protocol.ProtocolKeyword;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Lettuce (what odeysys uses) through the real agent and a real client against {@link MiniRedis}
 * (specs/011-redis-capture T025): every command of a call recorded in order with the exact bytes, whichever thread its
 * reply arrives on; nothing outside a call or without redis=1.
 */
class RedisCaptureLettuceIT {

    static MiniRedis redis;
    static RedisClient client;
    static StatefulRedisConnection<String, String> connection;

    @BeforeAll
    static void start() throws Exception {
        AgentTestSupport.reset();
        redis = new MiniRedis();
        client = RedisClient.create(redis.uri());
        connection = client.connect(); // HELLO / CLIENT SETINFO happen here, outside any call
    }

    @AfterAll
    static void stop() throws Exception {
        connection.close();
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
    void syncCommandsAreRecordedInOrderWithTheirRepliesAndKeys() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        AgentTestSupport.inCall("id=lt-sync; db=0; redis=1", () -> {
            sync.set("fare:rule:EK", "1.5");
            sync.get("fare:rule:EK");
            sync.get("fare:rule:QR");
            sync.incr("rate:org:948:upsell");
            sync.expire("rate:org:948:upsell", 60);
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-sync", 5);
        assertThat(names(r)).containsExactly("SET", "GET", "GET", "INCR", "EXPIRE");
        assertThat(r).extracting(x -> x.seq).containsExactly(1, 2, 3, 4, 5);
        assertThat(r.get(0).keys).containsExactly("fare:rule:EK");
        assertThat(r.get(0).replyType).isEqualTo("SIMPLE");
        assertThat(new String(r.get(1).reply, StandardCharsets.UTF_8)).isEqualTo("$3\r\n1.5\r\n");
        assertThat(r.get(2).replyType).isIn("NIL"); // RESP3 null (Lettuce negotiates HELLO 3)
        assertThat(r.get(3).replyType).isEqualTo("INTEGER");
        assertThat(r.get(0).client).startsWith("lettuce");
        assertThat(r.get(0).thread).isNotNull();
        assertThat(r.get(0).code).contains("RedisCaptureLettuceIT");
        assertThat(r.get(0).fingerprint).isEqualTo("SET fare:rule:EK [k,n]");
        assertThat(r.get(0).connection).startsWith("conn-r-");
        assertThat(r.get(0).server).endsWith(":" + redis.port());
        assertThat(new String(r.get(0).args, StandardCharsets.UTF_8)).isEqualTo("*3\r\n$3\r\nSET\r\n$12\r\nfare:rule:EK\r\n$3\r\n1.5\r\n");
        // the call's CALL_OPEN says its Redis commands are recorded
        assertThat(SINK.markers()).filteredOn(m -> "lt-sync".equals(m.callId) && "CALL_OPEN".equals(m.type)).extracting(m -> m.redis).containsExactly(true);
    }

    @Test
    void nothingIsRecordedOutsideACallOrWithoutRedisOne() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        sync.set("outside", "x");
        AgentTestSupport.inCall("id=lt-off; db=1", () -> sync.get("outside"));
        Thread.sleep(200);
        assertThat(SINK.redisOf("lt-off")).isEmpty();
    }

    @Test
    void asyncRepliesArrivingOnTheEventLoopStayWithTheirCall() throws Exception {
        RedisAsyncCommands<String, String> async = connection.async();
        AgentTestSupport.inCall("id=lt-async; db=0; redis=1", () -> {
            RedisFuture<String> a = async.set("k1", "v1");
            RedisFuture<String> b = async.get("k1");
            a.get(2, TimeUnit.SECONDS);
            b.get(2, TimeUnit.SECONDS);
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-async", 2);
        assertThat(names(r)).containsExactly("SET", "GET");
        assertThat(r.get(1).thread).doesNotContain("lettuce-"); // the sending thread, not the event loop
    }

    @Test
    void aCommandSentFromAWorkerThreadTheCallStartedBelongsToTheCall() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            AgentTestSupport.inCall("id=lt-worker; db=0; redis=1", () -> pool.submit(() -> sync.set("from:worker", "1")).get(2, TimeUnit.SECONDS));
        } finally {
            pool.shutdown();
        }
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-worker", 1);
        assertThat(names(r)).containsExactly("SET");
    }

    @Test
    void pipelinedCommandsAreOneGroup() throws Exception {
        StatefulRedisConnection<String, String> own = client.connect();
        try {
            RedisAsyncCommands<String, String> async = own.async();
            AgentTestSupport.inCall("id=lt-pipe; db=0; redis=1", () -> {
                own.setAutoFlushCommands(false);
                RedisFuture<String> a = async.set("p1", "1");
                RedisFuture<String> b = async.set("p2", "2");
                RedisFuture<String> c = async.get("p1");
                own.flushCommands();
                own.setAutoFlushCommands(true);
                c.get(2, TimeUnit.SECONDS);
                a.get(2, TimeUnit.SECONDS);
                b.get(2, TimeUnit.SECONDS);
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("lt-pipe", 3);
            assertThat(r).extracting(x -> x.groupKind).containsOnly("pipeline");
            assertThat(r).extracting(x -> x.groupId).containsOnly(r.get(0).groupId);
            assertThat(r).extracting(x -> x.groupIndex).containsExactly(0, 1, 2);
            assertThat(r).extracting(x -> x.groupSize).containsOnly(3);
        } finally {
            own.close();
        }
    }

    @Test
    void multiExecIsOneTransactionGroup() throws Exception {
        StatefulRedisConnection<String, String> own = client.connect();
        try {
            RedisCommands<String, String> sync = own.sync();
            AgentTestSupport.inCall("id=lt-tx; db=0; redis=1", () -> {
                sync.multi();
                sync.incr("rate:org:948:upsell");
                sync.expire("rate:org:948:upsell", 60);
                sync.exec();
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("lt-tx", 4);
            assertThat(names(r)).containsExactly("MULTI", "INCR", "EXPIRE", "EXEC");
            assertThat(r).extracting(x -> x.groupKind).containsOnly("tx");
            assertThat(r).extracting(x -> x.groupSize).containsOnly(4);
            assertThat(new String(r.get(1).reply, StandardCharsets.UTF_8)).isEqualTo("+QUEUED\r\n");
            assertThat(r.get(3).replyType).isEqualTo("ARRAY");
        } finally {
            own.close();
        }
    }

    @Test
    void aBigValueTravelsInPartsAndArrivesByteForByte() throws Exception {
        StatefulRedisConnection<byte[], byte[]> bin = client.connect(ByteArrayCodec.INSTANCE);
        try {
            byte[] big = new byte[1_800_000];
            for (int i = 0; i < big.length; i++) {
                big[i] = (byte) (i * 31 + 7);
            }
            byte[] key = "upsell:a5b4f2f0".getBytes(StandardCharsets.UTF_8);
            AgentTestSupport.inCall("id=lt-big; db=0; redis=1", () -> {
                bin.sync().setex(key, 900, big);
                bin.sync().get(key);
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("lt-big", 2);
            assertThat(r).allMatch(x -> x.chunked);
            byte[] args = SINK.bytesOf(r.get(0), "args");
            assertThat(args.length).isGreaterThan(big.length);
            assertThat(Arrays.copyOfRange(args, args.length - big.length - 2, args.length - 2)).isEqualTo(big);
            byte[] reply = SINK.bytesOf(r.get(1), "reply");
            assertThat(reply).isEqualTo(redis.replies.get(redis.replies.size() - 1)); // exactly what the server wrote
            assertThat(r.get(1).replyBytes).isEqualTo(reply.length);
        } finally {
            bin.close();
        }
    }

    @Test
    void errorRepliesAndBlockingWaitsAreRecorded() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        AgentTestSupport.inCall("id=lt-err; db=0; redis=1", () -> {
            try {
                sync.evalsha("3f1c9ea2", io.lettuce.core.ScriptOutputType.INTEGER, "lock:upsell:948");
            } catch (Exception expected) {
                // NOSCRIPT
            }
            sync.rpush("queue:jobs", "j1");
            sync.blpop(5, "queue:jobs");
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-err", 3);
        assertThat(names(r)).containsExactly("EVALSHA", "RPUSH", "BLPOP");
        assertThat(r.get(0).replyType).isEqualTo("ERROR");
        assertThat(r.get(0).error).startsWith("NOSCRIPT");
        assertThat(r.get(0).keys).containsExactly("lock:upsell:948");
        assertThat(r.get(2).micros).isGreaterThanOrEqualTo(250_000); // the full wait
    }

    @Test
    void resp3TypesAndTheRunTagAreKept() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        AgentTestSupport.inCall("id=lt-r3; db=0; redis=1; run=run-7/step-2", () -> {
            sync.hset("user:790:prefs", "currency", "AED");
            sync.hgetall("user:790:prefs");
            connection.sync().dispatch(Dbl.DOUBLE, new DoubleOutput<>(io.lettuce.core.codec.StringCodec.UTF8),
                    new CommandArgs<>(io.lettuce.core.codec.StringCodec.UTF8));
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-r3", 3);
        assertThat(r.get(1).replyType).isEqualTo("MAP");
        assertThat(r.get(1).resp).isEqualTo(3);
        assertThat(r.get(2).replyType).isEqualTo("DOUBLE");
        assertThat(r).extracting(x -> x.runTag).containsOnly("run-7/step-2");
    }

    @Test
    void sequenceIsSharedWithTheCallsStatements() throws Exception {
        RedisCommands<String, String> sync = connection.sync();
        AgentTestSupport.inCall("id=lt-seq; db=1; redis=1", () -> {
            sync.get("cache:supplier-airports:v3");
            try (Connection c = DriverManager.getConnection("jdbc:h2:mem:lt-seq"); Statement s = c.createStatement()) {
                s.execute("SELECT 2");
            }
            sync.set("cache:supplier-airports:v3", "[]");
        });
        List<RedisCommandRecord> r = SINK.awaitRedis("lt-seq", 2);
        int statementSeq = SINK.statementsOf("lt-seq").stream().filter(s -> s.sql.contains("SELECT 2")).findFirst().get().seq;
        assertThat(r.get(0).seq).isLessThan(statementSeq);
        assertThat(r.get(1).seq).isGreaterThan(statementSeq);
    }

    enum Dbl implements ProtocolKeyword {
        DOUBLE;

        @Override
        public byte[] getBytes() {
            return name().getBytes(StandardCharsets.US_ASCII);
        }
    }
}
