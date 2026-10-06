package com.fathy.alfred.backend;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The whole backend wires up and starts - every slice and bridge together. Unit tests build their beans by hand, so a
 * dependency cycle between slices (a bridge feeding triage while triage reads what session cycles hold) only showed
 * when the container refused to start (specs/010). Every file goes to a temporary folder.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
class BackendContextStartsTest {

    private static final Path DATA;

    static {
        try {
            DATA = Files.createTempDirectory("alfred-context");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static final List<String> FILES = List.of("CALLS_DB_FILE", "COMMENTS_DB_FILE", "COMMENTS_FILE", "DB_CAPTURE_DB_FILE",
            "DB_CAPTURE_TOGGLE_FILE", "FILTER_SETTINGS_DB_FILE", "FILTER_SETTINGS_FILE", "INTERCEPTION_DB_FILE", "INTERCEPTION_RULES_FILE",
            "INTERCEPTION_RULES_STORE_FILE", "INTERCEPTION_VARIABLES_FILE", "INTERNAL_CALLS_FILE", "LOGS_DB_FILE", "LOG_LINK_TOGGLE_FILE",
            "PROFILES_DB_FILE", "PROFILES_FILE", "RECENT_CALLS_FILE", "REDACTIONS_DB_FILE", "REDACTIONS_FILE", "RELIVE_DB_FILE",
            "REVERSE_PROXY_TOGGLE_FILE", "SCENARIOS_DB_FILE", "SESSION_CYCLES_DB_FILE", "SESSION_CYCLES_FILE", "TRIAGE_DB_FILE",
            "ALFRED_RESEND_MITM_CA_FILE");
    private static final List<String> DIRS = List.of("INTERCEPTION_ANSWERS_DIR", "INTERNAL_SESSION_CYCLES_DIR", "LOGS_ROOT_DIR",
            "LOGS_UPLOAD_DIR", "SESSION_CYCLES_DIR");

    @DynamicPropertySource
    static void files(DynamicPropertyRegistry registry) {
        for (String name : FILES) {
            registry.add(name, () -> DATA.resolve(name.toLowerCase()).toString());
        }
        for (String name : DIRS) {
            registry.add(name, () -> DATA.resolve(name.toLowerCase()).toString());
        }
    }

    @Autowired
    ApplicationContext context;

    @Test
    void everySliceAndBridgeStartsTogether() {
        assertThat(context.getBean(com.fathy.alfred.backend.investigationbridge.InvestigationService.class)).isNotNull();
        assertThat(context.getBean(com.fathy.alfred.backend.triagebridge.TriageImportFeed.class)).isNotNull();
    }
}
