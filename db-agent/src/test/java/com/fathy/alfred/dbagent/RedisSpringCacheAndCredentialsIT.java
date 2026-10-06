package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.redis.MiniRedis;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.cache.interceptor.CacheAspectSupport;
import org.springframework.data.redis.cache.RedisCache;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.Protocol;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.function.Supplier;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The Spring Cache origin of a command (T058) and credentials (T028): AUTH / HELLO AUTH arguments are never kept,
 * housekeeping is only recorded when asked.
 */
class RedisSpringCacheAndCredentialsIT {

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

    /** The service method Spring's aspect would intercept - its name and argument become the origin's method. */
    public Object load(String carrier) {
        return carrier;
    }

    @Test
    void aCommandSentThroughSpringCacheCarriesTheCacheAndTheMethod() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            RedisCache cache = new RedisCache("fareRules", key -> jedis.get("fareRules::" + key), (k, v) -> jedis.set("fareRules::" + k, String.valueOf(v)));
            AgentTestSupport.inCall("id=sc-1; db=0; redis=1", () -> {
                Supplier<Object> body = () -> {
                    Object hit = cache.lookup("EK");
                    if (hit == null) {
                        cache.put("EK", "1.5");
                    }
                    return hit;
                };
                new CacheAspectSupport().execute(body, this, getClass().getMethod("load", String.class), new Object[]{"EK"});
                jedis.get("plain");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("sc-1", 3);
            assertThat(r.get(0).command).isEqualTo("GET");
            assertThat(r.get(0).originCache).isEqualTo("fareRules");
            assertThat(r.get(0).originOperation).isEqualTo("@Cacheable");
            assertThat(r.get(0).originMethod).isEqualTo("RedisSpringCacheAndCredentialsIT.load(\"EK\")");
            assertThat(r.get(1).command).isEqualTo("SET");
            assertThat(r.get(1).originOperation).isEqualTo("cache put");
            assertThat(r.get(2).originCache).isNull(); // the code's own command
        }
    }

    @Test
    void housekeepingIsSkippedUnlessAskedAndCredentialsAreNeverKept() throws Exception {
        try (Jedis jedis = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=cr-off; db=0; redis=1", () -> {
                jedis.auth("s3cret-pass");
                jedis.ping();
                jedis.get("k");
            });
            assertThat(SINK.awaitRedis("cr-off", 1)).extracting(x -> x.command).containsExactly("GET");

            SETTINGS.applyRedis(false, true);
            AgentTestSupport.inCall("id=cr-on; db=0; redis=1", () -> {
                jedis.auth("s3cret-pass");
                jedis.sendCommand(Protocol.Command.CLIENT, "SETNAME", "app");
            });
            List<RedisCommandRecord> r = SINK.awaitRedis("cr-on", 2);
            assertThat(r).extracting(x -> x.command).containsExactly("AUTH", "CLIENT SETNAME");
            String args = new String(r.get(0).args, StandardCharsets.UTF_8);
            assertThat(args).doesNotContain("s3cret").contains("credentials not stored");
        }
        try (Jedis other = new Jedis("127.0.0.1", redis.port())) {
            AgentTestSupport.inCall("id=cr-hello; db=0; redis=1", () ->
                    other.sendCommand(Protocol.Command.HELLO, "2", "AUTH", "admin", "s3cret-pass"));
            List<RedisCommandRecord> r = SINK.awaitRedis("cr-hello", 1);
            String args = new String(r.get(0).args, StandardCharsets.UTF_8);
            assertThat(args).doesNotContain("s3cret").doesNotContain("admin").contains("AUTH");
        }
    }
}
