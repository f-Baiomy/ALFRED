package com.fathy.alfred.backend.server.domain.model;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class EnvDocumentTest {

    private static final String PROJECTS = SettingGroup.PROJECTS.envHeader();
    private static final String LOGS = SettingGroup.LOGS.envHeader();

    private static final String FILE = String.join("\n",
            "# Alfred settings",
            "",
            PROJECTS,
            "# Log calls INTO your apps",
            "REVERSE_PROXY_ENABLED=true",
            "INTERNAL_CALL_SERVICES=odeysys:9001:8080",
            "",
            LOGS,
            "ALFRED_LOGS_DIR=./logs-drop",
            "this line is not understood",
            "") ;

    @Test
    void anUnchangedRoundTripIsByteIdenticalForLfAndCrlf() {
        assertThat(EnvDocument.parse(FILE).render()).isEqualTo(FILE);
        String crlf = FILE.replace("\n", "\r\n");
        assertThat(EnvDocument.parse(crlf).render()).isEqualTo(crlf);
        String noTrailingNewline = FILE.stripTrailing();
        assertThat(EnvDocument.parse(noTrailingNewline).render()).isEqualTo(noTrailingNewline);
    }

    @Test
    void setRewritesAnExistingLineInPlaceAndTouchesNothingElse() {
        String after = EnvDocument.parse(FILE).set("REVERSE_PROXY_ENABLED", "false", PROJECTS).render();
        assertThat(after).isEqualTo(FILE.replace("REVERSE_PROXY_ENABLED=true", "REVERSE_PROXY_ENABLED=false"));
    }

    @Test
    void aNewKeyGoesAtTheEndOfItsGroupSectionBeforeTheBlankLine() {
        String after = EnvDocument.parse(FILE).set("INTERNAL_CALLS_RETENTION_ROWS", "5000", PROJECTS).render();
        assertThat(after).contains("INTERNAL_CALL_SERVICES=odeysys:9001:8080\nINTERNAL_CALLS_RETENTION_ROWS=5000\n\n" + LOGS);
    }

    @Test
    void aNewKeyOfAMissingGroupCreatesTheHeaderAtTheEnd() {
        String after = EnvDocument.parse(FILE).set("ALFRED_MEMORY", "3g", SettingGroup.STORAGE.envHeader()).render();
        assertThat(after).endsWith("this line is not understood\n\n" + SettingGroup.STORAGE.envHeader() + "\nALFRED_MEMORY=3g\n");
    }

    @Test
    void removeDeletesOnlyTheEntryLine() {
        String after = EnvDocument.parse(FILE).remove("ALFRED_LOGS_DIR").render();
        assertThat(after).isEqualTo(FILE.replace("ALFRED_LOGS_DIR=./logs-drop\n", ""));
    }

    @Test
    void readingFollowsTheScriptsRules() {
        EnvDocument doc = EnvDocument.parse("A = 1\nB=x=y\nA=2\n  # c\n");
        assertThat(doc.get("A")).contains("2");
        assertThat(doc.get("B")).contains("x=y");
        assertThat(doc.entries()).containsOnlyKeys("A", "B");
    }

    @Test
    void unknownLinesAreKeptAndReportedWithTheirLineNumber() {
        EnvDocument doc = EnvDocument.parse(FILE);
        assertThat(doc.unknownLines()).singleElement().satisfies(u -> {
            assertThat(u.lineNumber()).isEqualTo(10);
            assertThat(u.text()).isEqualTo("this line is not understood");
        });
    }

    @Test
    void theHashIsOfTheFileAsReadAndSurvivesEdits() {
        EnvDocument doc = EnvDocument.parse(FILE);
        assertThat(doc.contentHash()).isEqualTo(EnvDocument.hashOf(FILE)).hasSize(64);
        assertThat(doc.set("A", "1", PROJECTS).contentHash()).isEqualTo(doc.contentHash());
        assertThat(EnvDocument.hashOf(FILE + "x")).isNotEqualTo(doc.contentHash());
    }
}
