package com.fathy.alfred.backend.logs.domain.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Flattener, ObjectTextParser, ValueTyper, GroupKeyer and PatternMiner - the pure ingest rules. */
class IngestPrimitivesTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void flattenNestsPathsUnwrapsSingleArraysAndUnpacksJsonText() throws Exception {
        var r = new Flattener(mapper).flatten(mapper.readTree("""
                {"a":{"b":1,"c":["x"]},"list":[1,2],"body":"{\\"k\\":\\"v\\",\\"n\\":{\\"m\\":true}}","bad":"{not json}","empty":{}}"""));
        assertThat(r.values()).containsEntry("a.b", 1).containsEntry("a.c", "x").containsEntry("list", "[1,2]")
                .containsEntry("body.k", "v").containsEntry("body.n.m", true).containsEntry("bad", "{not json}")
                .doesNotContainKey("body").doesNotContainKey("empty");
        assertThat(r.unpackedRoots()).containsExactly("body");
    }

    @Test
    void javaToStringTextGetsItsKeysAsChildFieldsAndKeepsTheText() throws Exception {
        String text = "LoginDTO(email=a@b.c, password=null, tags=[x, y], nested=Inner(k=v, z=1))";
        var r = new Flattener(mapper).flatten(mapper.readTree(mapper.writeValueAsString(Map.of("request", text))));
        assertThat(r.values()).containsEntry("request", text).containsEntry("request.email", "a@b.c")
                .containsEntry("request.password", null).containsEntry("request.tags", "[x, y]")
                .containsEntry("request.nested", "Inner(k=v, z=1)");
        assertThat(ObjectTextParser.parse("just text")).isEmpty();
        assertThat(ObjectTextParser.parse("Foo(no pairs here)")).isEmpty();
    }

    @Test
    void valueTyperConvertsOrReturnsEmptyNeverThrows() {
        assertThat(ValueTyper.convert("2026-10-01T23:55:57.72Z", FieldType.DATETIME, "ISO-8601 · UTC")).contains(1790898957720L);
        assertThat(ValueTyper.convert("2026-10-02T03:55:57.720+04:00", FieldType.DATETIME, null)).contains(1790898957720L);
        assertThat(ValueTyper.convert(1790898957720L, FieldType.DATETIME, null)).contains(1790898957720L);
        assertThat(ValueTyper.convert(1790898957, FieldType.DATETIME, null)).contains(1790898957000L);
        assertThat(ValueTyper.convert("2026-10-01 (THURSDAY)", FieldType.DATE, "yyyy-MM-dd (EEEE)")).isPresent();
        assertThat(ValueTyper.convert("6183 ms", FieldType.NUMBER, "unit: ms")).contains(6183.0);
        assertThat(ValueTyper.convert(200, FieldType.NUMBER, "")).contains(200.0);
        assertThat(ValueTyper.convert("yes", FieldType.BOOLEAN, "yes = true · no = false")).contains(1L);
        assertThat(ValueTyper.convert(0, FieldType.BOOLEAN, "")).contains(0L);
        assertThat(ValueTyper.convert("N/A", FieldType.NUMBER, "")).isEmpty();
        assertThat(ValueTyper.convert("garbage", FieldType.DATETIME, "dd/MM/yyyy HH:mm")).isEmpty();
    }

    @Test
    void groupPlacementFollowsTheLevelRule() {
        assertThat(GroupKeyer.place(List.of("S1", "", ""))).isEqualTo(new GroupKeyer.Placement(1, "S1", -1));
        assertThat(GroupKeyer.place(List.of("S1", "IC7", ""))).isEqualTo(new GroupKeyer.Placement(2, "S1\u0001IC7", -1));
        assertThat(GroupKeyer.place(List.of("S1", "IC7", "EX31")).level()).isEqualTo(3);
        // Skipped level: A and C without B hangs under A with B missing.
        assertThat(GroupKeyer.place(java.util.Arrays.asList("S1", null, "EX31"))).isEqualTo(new GroupKeyer.Placement(1, "S1", 1));
        // No first id: the bucket.
        assertThat(GroupKeyer.place(java.util.Arrays.asList(null, "IC7", null))).isEqualTo(GroupKeyer.Placement.BUCKET);
        assertThat(GroupKeyer.ancestorsAndSelf("S1\u0001IC7\u0001EX31")).containsExactly("S1", "S1\u0001IC7", "S1\u0001IC7\u0001EX31");
        assertThat(new GroupKeyer.Placement(3, "S1\u0001IC7\u0001EX31", -1).parentPath()).isEqualTo("S1\u0001IC7");
    }

    @Test
    void patternMinerGroupsMessagesThatDifferOnlyInVariableParts() {
        PatternMiner m = new PatternMiner(1);
        long a = m.add("Supplier timeout after 30000 ms for Sabre").id();
        long b = m.add("Supplier timeout after 29000 ms for Amadeus").id();
        long c = m.add("Session start for user AGN1422").id();
        assertThat(a).isEqualTo(b).isNotEqualTo(c);
        PatternMiner restored = new PatternMiner(1);
        restored.restore(a, "Supplier timeout after ‹n› ms for ‹*›");
        assertThat(restored.add("Supplier timeout after 12 ms for X").id()).isEqualTo(a);
    }
}
