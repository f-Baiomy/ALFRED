package com.fathy.alfred.backend.logs.domain.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Objects;

import static org.assertj.core.api.Assertions.assertThat;

/** Detection on the real OpenSearch hit from the design discussion and on a raw detail.log body. */
class StructureDetectorTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private LogStructure detect(String... lines) throws Exception {
        Flattener f = new Flattener(mapper);
        List<Flattener.Result> sample = new java.util.ArrayList<>();
        for (String l : lines) {
            sample.add(f.flatten(mapper.readTree(l)));
        }
        return StructureDetector.detect(sample);
    }

    private static String fixture() throws Exception {
        return new String(Objects.requireNonNull(StructureDetectorTest.class.getResourceAsStream("/fixtures/opensearch-hit.ndjson"))
                .readAllBytes(), StandardCharsets.UTF_8).trim();
    }

    @Test
    void openSearchHitIsFlattenedTypedAndItsBodyMarkedDuplicate() throws Exception {
        LogStructure s = detect(fixture());

        FieldDef body = s.byPath("_source.body.message.correlationId").orElseThrow();
        assertThat(body.duplicateOf()).isEqualTo("_source.attributes.message.correlationId");
        assertThat(body.stored()).isFalse();

        assertThat(s.byPath("_source.attributes.message.context.request.email").orElseThrow().label()).isEqualTo("email");
        assertThat(s.byPath("fields.VM_name").orElseThrow().label()).isEqualTo("VM_name");
        assertThat(s.byLabel("correlationId").orElseThrow().role()).isEqualTo(Role.CORRELATION);
        assertThat(s.byRole(Role.TIME).orElseThrow().type()).isEqualTo(FieldType.DATETIME);
        assertThat(s.byRole(Role.LEVEL).orElseThrow().path()).isEqualTo("_source.attributes.log.level");
        assertThat(s.byRole(Role.MESSAGE).orElseThrow().searchMode()).isEqualTo(SearchMode.TEXT);
        assertThat(s.byLabel("date_with_weekday").orElseThrow().type()).isEqualTo(FieldType.DATE);

        FieldDef flag = s.byLabel("ERROR_flag").orElseThrow();
        assertThat(flag.type()).isEqualTo(FieldType.NUMBER);
        assertThat(flag.suggestBoolean()).isTrue();

        assertThat(s.fields().stream().map(FieldDef::label).distinct().count()).isEqualTo(s.fields().size());
        assertThat(s.template()).contains("{methodName}").contains("{message}");
        assertThat(s.id()).hasSize(12);
    }

    @Test
    void rawDetailLogBodyGetsTheSameRolesWithoutWrappers() throws Exception {
        String body = mapper.readTree(fixture()).path("_source").path("body").asText();
        LogStructure s = detect(body, body.replace("loginV2", "searchV2"));
        assertThat(s.byLabel("timestamp").orElseThrow().role()).isEqualTo(Role.TIME);
        assertThat(s.byLabel("level").orElseThrow().role()).isEqualTo(Role.LEVEL);
        assertThat(s.fields()).allMatch(FieldDef::stored);
    }

    @Test
    void sameFieldSetMeansSameStructureId() throws Exception {
        String body = mapper.readTree(fixture()).path("_source").path("body").asText();
        assertThat(detect(body).id()).isEqualTo(detect(body.replace("API request", "API response")).id());
        assertThat(detect(body).id()).isNotEqualTo(detect("{\"other\":1}").id());
    }

    @Test
    void aMixedSampleKeepsEveryFieldAndGivesARoleToAnAlternateName() throws Exception {
        String a = "{\"@timestamp\":\"2026-10-01T10:00:00Z\",\"level\":\"INFO\",\"message\":\"api\",\"service\":\"portal\"}";
        String a2 = "{\"@timestamp\":\"2026-10-01T10:00:01Z\",\"level\":\"INFO\",\"message\":\"api\",\"service\":\"portal\",\"extra\":1}";
        String b = "{\"time\":\"2026-10-02T09:00:00Z\",\"severity\":\"error\",\"job\":\"nightly\",\"records\":10}";
        LogStructure s = detect(a, a2, b);

        assertThat(s.fields()).extracting(FieldDef::label).contains("service", "job", "records", "extra");
        // "time" never appears in the same line as "@timestamp": a second name for the time.
        assertThat(s.rolesOf(Role.TIME)).extracting(FieldDef::label).containsExactly("@timestamp", "time");
        assertThat(s.rolesOf(Role.LEVEL)).extracting(FieldDef::label).containsExactly("level", "severity");

        Flattener f = new Flattener(mapper);
        List<Flattener.Result> sample = List.of(f.flatten(mapper.readTree(a)), f.flatten(mapper.readTree(a2)), f.flatten(mapper.readTree(b)));
        assertThat(StructureDetector.structureCount(sample)).isEqualTo(2); // one optional field is not a new structure
    }

    @Test
    void fieldsSeenTogetherAreNotAlternates() throws Exception {
        LogStructure s = detect("{\"timestamp\":\"2026-10-01T10:00:00Z\",\"time\":\"2026-10-01T10:00:00Z\",\"msg\":\"x\"}");
        assertThat(s.rolesOf(Role.TIME)).hasSize(1);
    }
}
