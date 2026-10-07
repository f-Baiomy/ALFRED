package com.fathy.alfred.backend.dbcapture.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The backend's RESP reader against the fixture the agent's RespFrameTest reads too (specs/011-redis-capture T023/T030). */
class RespTest {

    static JsonNode fixture() throws Exception {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null && !Files.exists(dir.resolve("specs/011-redis-capture/fixtures/resp-cases.json"))) {
            dir = dir.getParent();
        }
        assertThat(dir).as("specs/011-redis-capture/fixtures/resp-cases.json above the working directory").isNotNull();
        return new ObjectMapper().readTree(dir.resolve("specs/011-redis-capture/fixtures/resp-cases.json").toFile());
    }

    @Test
    void replyTypesVersionsAndErrorsMatchTheAgent() throws Exception {
        for (JsonNode c : fixture().get("replies")) {
            byte[] resp = c.get("resp").asText().getBytes(StandardCharsets.UTF_8);
            assertThat(Resp.type(resp)).as(c.get("resp").asText()).isEqualTo(c.get("type").asText());
            assertThat(Resp.version(resp)).as(c.get("resp").asText()).isEqualTo(c.get("version").asInt());
            if (c.has("error")) {
                assertThat(Resp.errorText(resp)).isEqualTo(c.get("error").asText());
            }
        }
    }

    @Test
    void requestsParseToTheirArgumentsAndKeyPatternsMatch() throws Exception {
        for (JsonNode c : fixture().get("requests")) {
            List<String> args = new ArrayList<>();
            c.get("args").forEach(a -> args.add(a.asText()));
            StringBuilder wire = new StringBuilder("*" + args.size() + "\r\n");
            for (String a : args) {
                wire.append('$').append(a.getBytes(StandardCharsets.UTF_8).length).append("\r\n").append(a).append("\r\n");
            }
            List<byte[]> parsed = Resp.args(wire.toString().getBytes(StandardCharsets.UTF_8));
            assertThat(parsed.stream().map(b -> new String(b, StandardCharsets.UTF_8)).toList()).isEqualTo(args);
            if (!c.get("pattern").isNull()) {
                assertThat(KeyPattern.of(c.get("keys").get(0).asText())).isEqualTo(c.get("pattern").asText());
            }
        }
    }

    @Test
    void previewsAndEmptiness() {
        assertThat(Resp.preview("$3\r\n1.5\r\n".getBytes(StandardCharsets.UTF_8), 200)).isEqualTo("1.5");
        assertThat(Resp.preview(":38\r\n".getBytes(StandardCharsets.UTF_8), 200)).isEqualTo("(integer) 38");
        assertThat(Resp.preview("%1\r\n+a\r\n+b\r\n".getBytes(StandardCharsets.UTF_8), 200)).isEqualTo("1 field");
        assertThat(Resp.preview("$-1\r\n".getBytes(StandardCharsets.UTF_8), 200)).isEqualTo("(nil)");
        assertThat(Resp.empty("*0\r\n".getBytes(StandardCharsets.UTF_8))).isTrue();
        assertThat(Resp.empty("_\r\n".getBytes(StandardCharsets.UTF_8))).isTrue();
        assertThat(Resp.empty(":0\r\n".getBytes(StandardCharsets.UTF_8))).isFalse();
        assertThat(Resp.preview(new byte[]{'$', '2', '\r', '\n', (byte) 0xac, (byte) 0xed, '\r', '\n'}, 200)).isEqualTo("‹binary 2 B›");
    }

    @Test
    void keyPatternsFoldSiblingsWithinACall() {
        assertThat(KeyPattern.ofAll(List.of("fare:rule:EK", "fare:rule:QR", "fare:rule:EY", "user:790:prefs", "cache:supplier-airports:v3")))
                .containsEntry("fare:rule:EK", "fare:rule:*").containsEntry("user:790:prefs", "user:*:prefs")
                .containsEntry("cache:supplier-airports:v3", "cache:supplier-airports:v3");
        assertThat(KeyPattern.ofAll(List.of("a:b:x", "a:b:y"))).containsEntry("a:b:x", "a:b:x"); // two are not a pattern
    }

    @Test
    void masksMatchGlobs() {
        KeyMask mask = new KeyMask(List.of("session:*", "*token*"));
        assertThat(mask.masks("session:odeysys:9f2a")).isTrue();
        assertThat(mask.masks("auth:token:1")).isTrue();
        assertThat(mask.masks("fare:rule:EK")).isFalse();
        assertThat(KeyMask.placeholder(1412)).isEqualTo("‹masked · 1,412 B›");
    }

    @Test
    void redisCliQuotesAndEscapes() {
        String line = RedisCli.line(List.of("SET".getBytes(), "k y".getBytes(), new byte[]{1, (byte) 0xff}, "EX".getBytes(), "9".getBytes()), false, 1);
        assertThat(line).isEqualTo("SET \"k y\" \"\\x01\\xff\" EX 9");
        assertThat(RedisCli.line(List.of("SET".getBytes(), "session:1".getBytes(), "secret".getBytes()), true, 1))
                .isEqualTo("SET session:1 ‹masked›");
    }
}
