package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Jedis 2.x - what Spring Data Redis 1.x applications ship (odeysys: jedis 2.9.0). Its {@code Protocol.Command} has a
 * public {@code raw} field and no {@code getRaw()}, its stream and pool live in {@code redis.clients.util}, and its
 * {@code sendCommand} is protected: every command used to be skipped ("⬢ Redis 0" on every call). Jedis 2.9 is loaded
 * through a class loader of its own (Jedis 5 is on the test classpath) and driven reflectively, as an application would.
 */
class RedisCaptureJedis2IT {

    static MiniRedis redis;
    static URLClassLoader loader;

    @BeforeAll
    static void start() throws Exception {
        AgentTestSupport.reset();
        redis = new MiniRedis();
        File dir = new File("target/legacy-redis");
        File[] jars = dir.listFiles((d, n) -> n.endsWith(".jar"));
        assertThat(jars).as("maven-dependency-plugin copies jedis 2.9.0 to " + dir).isNotEmpty();
        List<URL> urls = new ArrayList<>();
        for (File jar : jars) {
            urls.add(jar.toURI().toURL());
        }
        // parent: the platform/extension loader - never sees the Jedis 5 on the test classpath
        loader = new URLClassLoader(urls.toArray(new URL[0]), ClassLoader.getSystemClassLoader().getParent());
    }

    @AfterAll
    static void stop() throws Exception {
        redis.close();
        loader.close();
    }

    @BeforeEach
    void reset() {
        AgentTestSupport.reset();
        redis.reset();
    }

    private static Object call(Object target, String name, Object... args) throws Exception {
        for (Method m : target.getClass().getMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == args.length) {
                Class<?>[] p = m.getParameterTypes();
                boolean fits = true;
                for (int i = 0; i < p.length; i++) {
                    fits &= args[i] == null || p[i].isInstance(args[i]) || (p[i] == String.class && args[i] instanceof String);
                }
                if (fits && (p.length == 0 || p[0] == String.class || p[0] == Object.class)) {
                    return m.invoke(target, args);
                }
            }
        }
        throw new NoSuchMethodException(name);
    }

    private static List<String> names(List<RedisCommandRecord> records) {
        return records.stream().map(r -> r.command).collect(Collectors.toList());
    }

    @Test
    void jedis29CommandsAreRecordedWithTheirExactReplies() throws Exception {
        Class<?> jedisClass = loader.loadClass("redis.clients.jedis.Jedis");
        Object jedis = jedisClass.getConstructor(String.class, int.class).newInstance("127.0.0.1", redis.port());
        try {
            AgentTestSupport.inCall("id=j2-plain; db=0; redis=1", () -> {
                call(jedis, "set", "otp:user:948", "123456");
                call(jedis, "get", "otp:user:948");
                call(jedis, "get", "missing");
                call(jedis, "incr", "rate:org:948");
                call(jedis, "hset", "user:790:prefs", "currency", "AED");
                call(jedis, "hgetAll", "user:790:prefs");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("j2-plain", 6);
            assertThat(names(r)).containsExactly("SET", "GET", "GET", "INCR", "HSET", "HGETALL");
            assertThat(new String(r.get(0).reply, StandardCharsets.UTF_8)).isEqualTo("+OK\r\n");
            assertThat(new String(r.get(1).reply, StandardCharsets.UTF_8)).isEqualTo("$6\r\n123456\r\n");
            assertThat(r.get(2).replyType).isEqualTo("NIL");
            List<byte[]> server = redis.replies;
            for (int i = 0; i < r.size(); i++) {
                assertThat(r.get(i).reply).isEqualTo(server.get(server.size() - r.size() + i));
            }
            assertThat(r.get(0).client).startsWith("jedis");
            assertThat(r.get(0).code).contains("RedisCaptureJedis2IT");
            assertThat(new String(r.get(0).args, StandardCharsets.UTF_8)).startsWith("*3\r\n$3\r\nSET\r\n");
        } finally {
            call(jedis, "close");
        }
    }

    @Test
    void jedis29ValueBeforeAWrite() throws Exception {
        SETTINGS.applyRedis(true, false);
        Object jedis = loader.loadClass("redis.clients.jedis.Jedis").getConstructor(String.class, int.class).newInstance("127.0.0.1", redis.port());
        try {
            call(jedis, "set", "rate:org:948", "37");
            final Object[] result = new Object[1];
            AgentTestSupport.inCall("id=j2-before; db=0; redis=1", () -> {
                result[0] = call(jedis, "incr", "rate:org:948");
                call(jedis, "set", "otp:new", "x");
            });
            assertThat(result[0]).isEqualTo(38L); // the application's own result is unchanged
            List<RedisCommandRecord> r = SINK.awaitRedis("j2-before", 2);
            assertThat(names(r)).containsExactly("INCR", "SET");
            assertThat(new String(r.get(0).before, StandardCharsets.UTF_8)).isEqualTo("$2\r\n37\r\n");
            assertThat(r.get(0).beforeNote).startsWith("type string");
            assertThat(r.get(1).beforeNote).isEqualTo("(nil) - new key");
        } finally {
            SETTINGS.applyRedis(false, false);
            call(jedis, "close");
        }
    }

    @Test
    void jedis29PipelineAndTransactionAreGrouped() throws Exception {
        Object jedis = loader.loadClass("redis.clients.jedis.Jedis").getConstructor(String.class, int.class).newInstance("127.0.0.1", redis.port());
        try {
            AgentTestSupport.inCall("id=j2-groups; db=0; redis=1", () -> {
                Object tx = call(jedis, "multi");
                call(tx, "set", "a", "1");
                call(tx, "incr", "a");
                call(tx, "exec");
                Object pipe = call(jedis, "pipelined");
                call(pipe, "get", "a");
                call(pipe, "get", "b");
                call(pipe, "sync");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("j2-groups", 6);
            assertThat(names(r)).containsExactly("MULTI", "SET", "INCR", "EXEC", "GET", "GET");
            assertThat(r.get(0).groupKind).isEqualTo("tx");
            assertThat(r.get(3).groupId).isEqualTo(r.get(0).groupId);
            assertThat(r.get(4).groupKind).isEqualTo("pipeline");
            assertThat(r.get(5).groupId).isEqualTo(r.get(4).groupId);
        } finally {
            call(jedis, "close");
        }
    }
}
