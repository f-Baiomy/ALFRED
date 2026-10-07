package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import io.lettuce.core.RedisClient;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.Jedis;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * SC-003 of specs/011-redis-capture: what recording adds to each Redis command. The same 100-command call (reads and
 * writes of small values) runs with ⬢ off for the call (redis=0 - the agent is attached and its hooks run, but record
 * nothing) and with it on, interleaved so JIT and GC hit both sides alike, on Lettuce and on Jedis.
 *
 * <p>MiniRedis answers on the loopback in tens of microseconds, so the relative overhead here is far above what a real
 * Redis across a network shows (0.2-1 ms per round trip): the assertion is on the absolute cost added per command
 * (≤ 0.2 ms), and the numbers printed are what docs/db-capture.md quotes.
 */
class RedisOverheadIT {

    private static final int COMMANDS_PER_CALL = 100;
    private static final int ITERATIONS = 300;
    private static MiniRedis redis;

    @BeforeAll
    static void start() throws Exception {
        AgentTestSupport.reset();
        redis = new MiniRedis();
    }

    @AfterAll
    static void stop() throws Exception {
        redis.close();
    }

    private static void hundred(Command c) throws Exception {
        for (int i = 0; i < COMMANDS_PER_CALL; i++) {
            if (i % 4 == 3) {
                c.set("fare:rule:" + (i % 20), "{\"fare\":" + i + ",\"currency\":\"AED\"}");
            } else {
                c.get("fare:rule:" + (i % 20));
            }
        }
    }

    interface Command {
        void set(String key, String value) throws Exception;

        void get(String key) throws Exception;
    }

    private static double addedMicrosPerCommand(String name, Command c) throws Exception {
        for (int i = 0; i < 100; i++) { // warm up both paths
            final int n = i;
            AgentTestSupport.inCall("id=" + name + "-woff-" + n + "; db=0; redis=0", () -> hundred(c));
            AgentTestSupport.inCall("id=" + name + "-won-" + n + "; db=0; redis=1", () -> hundred(c));
        }
        AgentTestSupport.reset();
        redis.reset();
        long off = 0;
        long on = 0;
        for (int i = 0; i < ITERATIONS; i++) {
            final int n = i;
            long a = System.nanoTime();
            AgentTestSupport.inCall("id=" + name + "-off-" + n + "; db=0; redis=0", () -> hundred(c));
            off += System.nanoTime() - a;
            long b = System.nanoTime();
            AgentTestSupport.inCall("id=" + name + "-on-" + n + "; db=0; redis=1", () -> hundred(c));
            on += System.nanoTime() - b;
            if (i % 25 == 24) {
                AgentTestSupport.reset(); // the collecting sink would otherwise grow without bound
                redis.reset();
            }
        }
        double offMicros = off / 1_000.0 / ITERATIONS;
        double onMicros = on / 1_000.0 / ITERATIONS;
        double added = (onMicros - offMicros) / COMMANDS_PER_CALL;
        System.out.printf("[overhead] %s, %d-command call, MiniRedis on loopback, %d iterations, Java %s: capture off %.1f us/call, on %.1f us/call,"
                        + " added %.2f us per command (%.1f %% of the loopback round trip)%n", name, COMMANDS_PER_CALL, ITERATIONS,
                System.getProperty("java.version"), offMicros, onMicros, added, (onMicros - offMicros) / offMicros * 100);
        return added;
    }

    @Test
    void lettuceAddsLittleToEachCommand() throws Exception {
        RedisClient client = RedisClient.create("redis://127.0.0.1:" + redis.port());
        try (StatefulRedisConnection<String, String> connection = client.connect()) {
            RedisCommands<String, String> sync = connection.sync();
            double added = addedMicrosPerCommand("lettuce", new Command() {
                @Override
                public void set(String key, String value) {
                    sync.set(key, value);
                }

                @Override
                public void get(String key) {
                    sync.get(key);
                }
            });
            assertThat(added).isLessThan(200.0);
        } finally {
            client.shutdown();
        }
    }

    @Test
    void jedisAddsLittleToEachCommand() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            double added = addedMicrosPerCommand("jedis", new Command() {
                @Override
                public void set(String key, String value) {
                    jedis.set(key, value);
                }

                @Override
                public void get(String key) {
                    jedis.get(key);
                }
            });
            assertThat(added).isLessThan(200.0);
        }
    }
}
