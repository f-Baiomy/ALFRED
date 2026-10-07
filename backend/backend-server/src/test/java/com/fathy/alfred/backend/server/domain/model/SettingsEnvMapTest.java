package com.fathy.alfred.backend.server.domain.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * settings-env-map.json is how a saved setting reaches the processes (analysis U1): if a key were missing, or named a
 * variable no code reads, the native install would silently ignore that setting.
 */
class SettingsEnvMapTest {

    /** Variables Spring Boot binds by itself (relaxed binding of server.port), not through a placeholder. */
    private static final Set<String> SPRING_BOUND = Set.of("SERVER_PORT");
    /** Read by this slice itself through @Value once its web adapter exists; listed here until then. */
    private static final Set<String> READ_BY_SERVER_SLICE = Set.of("ALFRED_SETTINGS_EDIT_FROM");

    private static JsonNode map;
    private static Set<String> variablesTheBackendReads;

    @BeforeAll
    static void load() throws IOException {
        try (InputStream in = SettingsEnvMapTest.class.getResourceAsStream("/settings-env-map.json")) {
            map = new ObjectMapper().readTree(in).get("settings");
        }
        variablesTheBackendReads = new HashSet<>();
        Pattern placeholder = Pattern.compile("\\$\\{([A-Z][A-Z0-9_]*)");
        try (Stream<Path> files = Files.walk(Path.of(".."))) {
            files.filter(f -> f.toString().replace('\\', '/').contains("/src/main/"))
                    .filter(f -> f.toString().endsWith(".java") || f.toString().endsWith(".properties"))
                    .forEach(f -> {
                        try {
                            Matcher m = placeholder.matcher(Files.readString(f));
                            while (m.find()) {
                                variablesTheBackendReads.add(m.group(1));
                            }
                        } catch (IOException e) {
                            throw new IllegalStateException(e);
                        }
                    });
        }
    }

    @Test
    void everyCatalogKeyIsMapped() {
        SettingCatalog.all().forEach(definition ->
                assertThat(map.has(definition.key())).as(definition.key() + " missing from settings-env-map.json").isTrue());
        map.fieldNames().forEachRemaining(key ->
                assertThat(SettingCatalog.find(key)).as(key + " is not a catalog setting").isPresent());
    }

    @Test
    void everyBackendVariableIsReadSomewhereInTheBackend() {
        map.fields().forEachRemaining(entry -> entry.getValue().get("backendEnv").forEach(variable -> {
            String name = variable.asText();
            assertThat(variablesTheBackendReads.contains(name) || SPRING_BOUND.contains(name) || READ_BY_SERVER_SLICE.contains(name))
                    .as(entry.getKey() + " -> " + name + " is read nowhere in backend/**/src/main").isTrue();
        }));
    }
}
