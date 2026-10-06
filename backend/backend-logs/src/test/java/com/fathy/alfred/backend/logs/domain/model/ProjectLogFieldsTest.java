package com.fathy.alfred.backend.logs.domain.model;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The fields as the Logs tab really names them: label = the last path segment ("call", "name"). */
class ProjectLogFieldsTest {

    private static FieldDef field(int i, String path, String label) {
        return new FieldDef(i, path, label, FieldType.STRING, TypeSource.AUTO, null, 1.0, 0, false, SearchMode.TEXT, null, false, null, 0, null);
    }

    /** What WildFly's JSON formatter writes: {"process.thread.name":"default task-1", ..., "alfred.call":"<id>"}. */
    private static final LogStructure WILDFLY = new LogStructure("st", List.of(
            field(0, "timestamp", "timestamp"), field(1, "process.thread.name", "name"), field(2, "log.logger", "logger"),
            field(3, "alfred.call", "call"), field(4, "message.methodName", "methodName")),
            List.of(), null, List.of(), null, "UTC", List.of(), List.of(), null);

    @Test
    void theDefaultMdcNameFindsATopLevelAlfredCall() {
        assertThat(ProjectLogFields.callId(WILDFLY, "mdc.alfred.call")).map(FieldDef::label).contains("call");
        assertThat(ProjectLogFields.callId(WILDFLY, null)).map(FieldDef::label).contains("call");
    }

    @Test
    void aThreadFieldIsFoundByItsPathWhenUnsetAndByLabelOrPathWhenSet() {
        assertThat(ProjectLogFields.thread(WILDFLY, null)).map(FieldDef::path).contains("process.thread.name");
        assertThat(ProjectLogFields.thread(WILDFLY, "process.thread.name")).map(FieldDef::label).contains("name");
        assertThat(ProjectLogFields.thread(WILDFLY, "name")).map(FieldDef::path).contains("process.thread.name");
        assertThat(ProjectLogFields.thread(WILDFLY, "nope")).isEmpty();
    }

    @Test
    void nothingMatchesWhereTheLogHasNoSuchField() {
        LogStructure plain = new LogStructure("st", List.of(field(0, "message", "message")), List.of(), null, List.of(), null, "UTC",
                List.of(), List.of(), null);
        assertThat(ProjectLogFields.callId(plain, "mdc.alfred.call")).isEmpty();
        assertThat(ProjectLogFields.thread(plain, null)).isEmpty();
        // "methodName" must not pass for a thread name
        assertThat(ProjectLogFields.thread(WILDFLY, null).map(FieldDef::label).orElse("")).isNotEqualTo("methodName");
    }
}
