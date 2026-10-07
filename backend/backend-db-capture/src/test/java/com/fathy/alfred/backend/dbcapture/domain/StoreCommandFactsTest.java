package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** What ALFRED derives when it stores a Redis command (specs/011-redis-capture T020). */
class StoreCommandFactsTest {

    static byte[] req(String... args) {
        StringBuilder s = new StringBuilder("*" + args.length + "\r\n");
        for (String a : args) {
            s.append('$').append(a.length()).append("\r\n").append(a).append("\r\n");
        }
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    static IncomingStoreCommand cmd(String command, List<String> keys, byte[] args, byte[] reply, String error) {
        return new IncomingStoreCommand("redis", "s1", "call-1", null, 3, "2026-10-06T21:36:41.084Z", 500, command, keys, keys.size(), args, reply,
                Resp.type(reply), 2, error, 0, 0, false, "lettuce", "conn-r-1", "redis:6379", 0, "t", null, null, null, null, null, null, null,
                null, 0, "fp");
    }

    @Test
    void outcomes() {
        byte[] hit = "$3\r\nabc\r\n".getBytes(StandardCharsets.UTF_8);
        byte[] nil = "$-1\r\n".getBytes(StandardCharsets.UTF_8);
        assertThat(StoreCommandFacts.outcome(cmd("GET", List.of("k"), req("GET", "k"), hit, null), hit)).isEqualTo("HIT");
        assertThat(StoreCommandFacts.outcome(cmd("GET", List.of("k"), req("GET", "k"), nil, null), nil)).isEqualTo("MISS");
        byte[] ok = "+OK\r\n".getBytes(StandardCharsets.UTF_8);
        assertThat(StoreCommandFacts.outcome(cmd("SET", List.of("k"), req("SET", "k", "v"), ok, null), ok)).isEqualTo("OK");
        byte[] err = "-NOSCRIPT x\r\n".getBytes(StandardCharsets.UTF_8);
        assertThat(StoreCommandFacts.outcome(cmd("EVALSHA", List.of("k"), req("EVALSHA", "s", "1", "k"), err, null), err)).isEqualTo("FAILED");
        assertThat(StoreCommandFacts.outcome(cmd("GET", List.of("k"), req("GET", "k"), null, "timeout"), null)).isEqualTo("FAILED");
        byte[] zero = ":0\r\n".getBytes(StandardCharsets.UTF_8);
        assertThat(StoreCommandFacts.outcome(cmd("EXISTS", List.of("k"), req("EXISTS", "k"), zero, null), zero)).isEqualTo("MISS");
        assertThat(StoreCommandFacts.rw("PUBLISH")).isEqualTo("o");
    }

    @Test
    void keyRowsCarryValueHashesAndTtls() {
        byte[] ok = "+OK\r\n".getBytes(StandardCharsets.UTF_8);
        IncomingStoreCommand set = cmd("SET", List.of("upsell:a5"), req("SET", "upsell:a5", "{}", "EX", "900"), ok, null);
        List<StoredKey> w = StoreCommandFacts.keys("odeysys", set, set.args(), ok, "OK");
        assertThat(w).singleElement().satisfies(k -> {
            assertThat(k.op()).isEqualTo("w");
            assertThat(k.ttlMs()).isEqualTo(900_000L);
            assertThat(k.valueHash()).isEqualTo(StoreCommandFacts.sha256("{}".getBytes(StandardCharsets.UTF_8)));
        });
        byte[] hit = "$2\r\n{}\r\n".getBytes(StandardCharsets.UTF_8);
        IncomingStoreCommand get = cmd("GET", List.of("upsell:a5"), req("GET", "upsell:a5"), hit, null);
        assertThat(StoreCommandFacts.keys("odeysys", get, get.args(), hit, "HIT")).singleElement()
                .satisfies(k -> assertThat(k.valueHash()).isEqualTo(w.get(0).valueHash()));
        IncomingStoreCommand pub = cmd("PUBLISH", List.of("ch"), req("PUBLISH", "ch", "m"), ":2\r\n".getBytes(), null);
        assertThat(StoreCommandFacts.keys("odeysys", pub, pub.args(), pub.reply(), "OK")).isEmpty();
    }

    @Test
    void previewsAndArgsText() {
        byte[] hit = "$1412\r\n".getBytes(StandardCharsets.UTF_8);
        assertThat(StoreCommandFacts.replyPreview("MISS", "$-1\r\n".getBytes(), null)).isEqualTo("MISS (nil)");
        assertThat(StoreCommandFacts.replyPreview("HIT", "$3\r\nabc\r\n".getBytes(), null)).isEqualTo("HIT 3 B");
        assertThat(StoreCommandFacts.argsText("SET", Resp.args(req("SET", "k", "v", "EX", "900")), 1)).isEqualTo("v EX 900");
        assertThat(StoreCommandFacts.size(1_887_437)).isEqualTo("1.8 MB");
        assertThat(hit).isNotEmpty();
    }
}
