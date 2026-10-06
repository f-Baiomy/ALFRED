package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.MiniJson;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * RESP framing, reply types, keys, patterns and fingerprints (specs/011-redis-capture T030), against the fixture the
 * backend's RespTest reads too - one truth for both readers.
 */
class RespFrameTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> fixture() throws Exception {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.exists(dir.resolve("specs/011-redis-capture/fixtures/resp-cases.json"))) {
            dir = dir.getParent();
        }
        assertThat(dir).as("specs/011-redis-capture/fixtures/resp-cases.json above the working directory").isNotNull();
        String json = new String(Files.readAllBytes(dir.resolve("specs/011-redis-capture/fixtures/resp-cases.json")), StandardCharsets.UTF_8);
        return (Map<String, Object>) MiniJson.parse(json);
    }

    @Test
    @SuppressWarnings("unchecked")
    void replyTypesVersionsAndErrorsMatchTheSharedFixture() throws Exception {
        for (Object o : (List<Object>) fixture().get("replies")) {
            Map<String, Object> c = (Map<String, Object>) o;
            byte[] resp = ((String) c.get("resp")).getBytes(StandardCharsets.UTF_8);
            assertThat(RespFrame.type(resp)).as((String) c.get("resp")).isEqualTo(c.get("type"));
            assertThat(RespFrame.version(resp)).as((String) c.get("resp")).isEqualTo(((Number) c.get("version")).intValue());
            assertThat(RespFrame.frameEnd(resp, 0, resp.length)).as("complete frame " + c.get("resp")).isEqualTo(resp.length);
            assertThat(RespFrame.frameEnd(resp, 0, resp.length - 1)).as("incomplete " + c.get("resp")).isEqualTo(-1);
            if (c.containsKey("error")) {
                assertThat(RespFrame.errorText(resp)).isEqualTo(c.get("error"));
            }
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void commandsKeysPatternsAndFingerprintsMatchTheSharedFixture() throws Exception {
        for (Object o : (List<Object>) fixture().get("requests")) {
            Map<String, Object> c = (Map<String, Object>) o;
            List<byte[]> args = new ArrayList<>();
            for (Object a : (List<Object>) c.get("args")) {
                args.add(((String) a).getBytes(StandardCharsets.UTF_8));
            }
            byte[] wire = RespFrame.request(args);
            List<byte[]> parsed = RespFrame.args(wire, 0, wire.length);
            assertThat(parsed).hasSameSizeAs(args);
            List<byte[]> keys = RespFrame.keys(parsed);
            List<String> keyText = new ArrayList<>();
            for (byte[] k : keys) {
                keyText.add(RespFrame.text(k));
            }
            String command = RespFrame.commandName(parsed);
            assertThat(command).isEqualTo(c.get("command"));
            assertThat(keyText).isEqualTo(c.get("keys"));
            assertThat(keys.isEmpty() ? null : RespFrame.pattern(keyText.get(0))).isEqualTo(c.get("pattern"));
            assertThat(RespFrame.fingerprint(command, parsed, keys)).isEqualTo(c.get("fingerprint"));
        }
    }

    @Test
    void anEncodersOutputSplitsIntoItsCommands() {
        byte[] one = RespFrame.request(Arrays.asList(b("SET"), b("a"), b("1")));
        byte[] two = RespFrame.request(Arrays.asList(b("GET"), b("a")));
        byte[] both = new byte[one.length + two.length];
        System.arraycopy(one, 0, both, 0, one.length);
        System.arraycopy(two, 0, both, one.length, two.length);
        int end = RespFrame.frameEnd(both, 0, both.length);
        assertThat(end).isEqualTo(one.length);
        assertThat(RespFrame.frameEnd(both, end, both.length)).isEqualTo(both.length);
    }

    @Test
    void credentialsAreReplacedAndHousekeepingRecognised() {
        List<byte[]> auth = RespFrame.scrubbed(Arrays.asList(b("AUTH"), b("admin"), b("s3cret")));
        assertThat(new String(RespFrame.request(auth), StandardCharsets.UTF_8)).doesNotContain("s3cret").doesNotContain("admin");
        List<byte[]> hello = RespFrame.scrubbed(Arrays.asList(b("HELLO"), b("3"), b("AUTH"), b("u"), b("p"), b("SETNAME"), b("app")));
        assertThat(RespFrame.text(hello.get(3))).isEqualTo(RespFrame.CREDENTIALS);
        assertThat(RespFrame.text(hello.get(6))).isEqualTo("app");
        assertThat(RespFrame.housekeeping(Arrays.asList(b("ping")))).isTrue();
        assertThat(RespFrame.housekeeping(Arrays.asList(b("GET"), b("k")))).isFalse();
    }

    @Test
    void binaryKeysAreEscaped() {
        assertThat(RespFrame.text(new byte[]{'k', 0x01, (byte) 0xff})).isEqualTo("k\\x01\\xff");
    }

    private static byte[] b(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
