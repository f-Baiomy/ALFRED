package com.fathy.alfred.backend.links.domain;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class RefsTest {

    @Test
    void aRefSplitsAtItsOutermostLinkAndAnEmailIsNeverARef() {
        assertThat(RemoteRef.outer("8f1c-77@stg83")).hasValueSatisfying(s -> {
            assertThat(s.inner()).isEqualTo("8f1c-77");
            assertThat(s.slug()).isEqualTo("stg83");
        });
        assertThat(RemoteRef.outer("8f1c@stg83@pc-1")).hasValueSatisfying(s -> {
            assertThat(s.inner()).isEqualTo("8f1c@stg83");
            assertThat(s.slug()).isEqualTo("pc-1");
        });
        assertThat(RemoteRef.outer("fathy@gmail.com")).isEmpty();
        assertThat(RemoteRef.outer("@stg83")).isEmpty();
        assertThat(RemoteRef.outer("abc@")).isEmpty();
        assertThat(RemoteRef.outer("abc@-x")).isEmpty();
        // a board's call ref keeps its cycle after the call: the cycle id is far longer than a slug
        assertThat(RemoteRef.outer("in:8f1c@3b4f0d6e-6f1c-4b0f-9a55-111111111111")).isEmpty();
        assertThat(RemoteRef.local("a@b@c")).isEqualTo("a");
        assertThat(RemoteRef.hops("a@b@c")).isEqualTo(2);
        assertThat(RemoteRef.hops("plain")).isZero();
    }

    @Test
    void slugsAreShortLowerCaseAndUnique() {
        assertThat(Slugs.of("QA server", List.of())).isEqualTo("qa-server");
        assertThat(Slugs.of("QA server", List.of("qa-server"))).isEqualTo("qa-server-2");
        assertThat(Slugs.of("Ünïcode / Name!!", List.of())).isEqualTo("unicode-name");
        assertThat(Slugs.of("", List.of())).isEqualTo("alfred");
        assertThat(Slugs.of("a very long name for an alfred box on the lan", List.of())).hasSizeLessThanOrEqualTo(Slugs.MAX)
                .matches(RemoteRef.SLUG.asPredicate());
    }

    @Test
    void idsAndMentionsAreTaggedButCallDataIsCopiedByteForByte() {
        String json = """
                {"id":"c1","name":"x","calls":[{"id":"k1","callId":"k1","requestHeaders":{"X-Request-Id":"r1","id":"h"},
                "requestBody":"{\\"id\\":\\"b\\"}","rows":[{"id":"row"}],"count":3,"description":"see @[call:in:k1@c1|it]"}],
                "cycleIds":["c1","c2"]}""";
        String out = JsonRewriter.rewrite(json, new RefTagger("stg83"));
        assertThat(out).contains("\"id\":\"c1@stg83\"").contains("\"callId\":\"k1@stg83\"").contains("\"cycleIds\":[\"c1@stg83\",\"c2@stg83\"]")
                .contains("\"X-Request-Id\":\"r1\"").contains("\"id\":\"h\"").contains("\"requestBody\":\"{\\\"id\\\":\\\"b\\\"}\"")
                .contains("{\"id\":\"row\"}").contains("\"count\":3").contains("@[call:in:k1@c1@stg83|it]");
    }

    @Test
    void scalarsCanBeReplacedAndHugeStringsPassThrough() {
        String big = "x".repeat(25_000_000);
        String json = "{\"rows\":[{\"card_token\":4111}],\"b\":\"" + big + "\"}";
        String out = JsonRewriter.rewrite(json, new JsonRewriter.Visitor() {
            @Override
            public String string(java.util.Deque<String> path, String value) {
                return value;
            }

            @Override
            public String scalar(java.util.Deque<String> path) {
                return "card_token".equals(path.peekLast()) ? "***" : null;
            }
        });
        assertThat(out).contains("\"card_token\":\"***\"").hasSize(json.length() + 1);
        assertThat(Set.of(out.substring(out.length() - 3))).containsExactly("x\"}");
    }
}
