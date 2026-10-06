package com.fathy.alfred.backend.dbcapture.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The shared vectors (specs/010-mcp-log-investigation/fixtures/fingerprint-vectors.json) - the MCP server's port of
 * these rules is tested against the same file, so both group log lines the same way.
 */
class LogFingerprintTest {

    private static final Path VECTORS = Path.of("..", "..", "specs", "010-mcp-log-investigation", "fixtures", "fingerprint-vectors.json");

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    @Test
    void sameGroupSameFingerprintAndDifferentGroupsNeverMerge() throws Exception {
        JsonNode file = new ObjectMapper().readTree(Files.readString(VECTORS));
        Map<String, String> byGroup = new HashMap<>();
        Map<String, String> groupOf = new HashMap<>();
        List<String> failures = new ArrayList<>();
        for (JsonNode v : file.get("cases")) {
            String group = v.get("group").asText();
            String message = text(v, "message");
            String normalised = LogFingerprint.normalise(message);
            if (!normalised.equals(v.get("normalised").asText())) {
                failures.add(group + ": normalised to \"" + normalised + "\"");
            }
            String fp = LogFingerprint.of(text(v, "logger"), text(v, "exceptionType"), message);
            String known = byGroup.putIfAbsent(group, fp);
            if (known != null && !known.equals(fp)) {
                failures.add(group + ": two fingerprints");
            }
            String other = groupOf.putIfAbsent(fp, group);
            if (other != null && !other.equals(group)) {
                failures.add(group + " merged with " + other);
            }
        }
        assertThat(failures).isEmpty();
        assertThat(byGroup).hasSizeGreaterThanOrEqualTo(20);
    }

    @Test
    void sixteenHexCharactersAndALongMessageIsCut() {
        assertThat(LogFingerprint.of("L", null, "x")).matches("[0-9a-f]{16}");
        assertThat(LogFingerprint.normalise("word ".repeat(200))).hasSize(LogFingerprint.MAX_NORMALISED);
    }
}
