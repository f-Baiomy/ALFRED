package com.fathy.alfred.backend.server.domain.model;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SettingsValidatorTest {

    private static SettingDefinition def(String key) {
        return SettingCatalog.find(key).orElseThrow();
    }

    private static List<ValidationResult> errors(String key, String value) {
        Map<String, String> effective = new HashMap<>();
        effective.put("ALFRED_UI_PORT", "3000");
        effective.put(key, value);
        return SettingsValidator.validate(effective, Set.of(key)).stream()
                .filter(r -> r.level() == ValidationResult.Level.ERROR).toList();
    }

    @Test
    void sizesAreStoredInBytes() {
        assertThat(SettingsValidator.normalize(def("ALFRED_CALLS_MAX_SIZE_BYTES"), "2 GB")).isEqualTo("2147483648");
        assertThat(SettingsValidator.normalize(def("ALFRED_CALLS_MAX_SIZE_BYTES"), "500MB")).isEqualTo("524288000");
        assertThat(SettingsValidator.normalize(def("ALFRED_CALLS_MAX_SIZE_BYTES"), "1.5gb")).isEqualTo("1610612736");
        assertThat(SettingsValidator.normalize(def("ALFRED_CALLS_MAX_SIZE_BYTES"), "10737418240")).isEqualTo("10737418240");
        assertThatThrownBy(() -> SettingsValidator.normalize(def("ALFRED_CALLS_MAX_SIZE_BYTES"), "lots"))
                .hasMessageContaining("not a size");
        assertThat(errors("ALFRED_CALLS_MAX_SIZE_BYTES", "1MB")).singleElement().satisfies(r -> assertThat(r.message()).contains("at least 10 MB"));
    }

    @Test
    void memoryAndBooleansAndEnums() {
        assertThat(SettingsValidator.normalize(def("ALFRED_MEMORY"), "3G")).isEqualTo("3g");
        assertThat(SettingsValidator.memoryInMegabytes("1536m")).isEqualTo(1536);
        assertThat(errors("ALFRED_MEMORY", "256m")).singleElement().satisfies(r -> assertThat(r.message()).contains("512m"));
        assertThat(errors("ALFRED_MEMORY", "2gb")).hasSize(1);
        assertThat(SettingsValidator.normalize(def("REVERSE_PROXY_ENABLED"), "on")).isEqualTo("true");
        assertThat(errors("REVERSE_PROXY_ENABLED", "maybe")).hasSize(1);
        assertThat(SettingsValidator.normalize(def("ALFRED_LOGS_WATCH_MODE"), "Agent")).isEqualTo("agent");
        assertThat(errors("ALFRED_LOGS_WATCH_MODE", "fast")).singleElement()
                .satisfies(r -> assertThat(r.message()).isEqualTo("use auto, events, agent"));
    }

    @Test
    void portsRetentionAndAddresses() {
        assertThat(errors("ALFRED_UI_PORT", "70000")).hasSize(1);
        assertThat(errors("ALFRED_UI_PORT", "x")).hasSize(1);
        assertThat(errors("INTERNAL_CALLS_RETENTION_ROWS", "50")).hasSize(1);
        assertThat(errors("INTERNAL_CALLS_RETENTION_ROWS", "5000")).isEmpty();
        assertThat(errors("ALFRED_OUTBOUND_PROXY_LISTEN", "127.0.0.2:8443")).isEmpty();
        assertThat(errors("ALFRED_OUTBOUND_PROXY_LISTEN", "8443")).hasSize(1);
    }

    @Test
    void projects() {
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:9001:8080,b:9002:8081:127.0.0.3")).isEmpty();
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:9001:8080,b:9001:8081")).extracting(ValidationResult::message)
                .anyMatch(m -> m.contains("9001 is used by two projects"));
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:9001:8080,a:9002:8081")).extracting(ValidationResult::message)
                .anyMatch(m -> m.contains("used twice"));
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:9001:9001")).hasSize(1);
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:3000:8080")).extracting(ValidationResult::message)
                .anyMatch(m -> m.contains("web UI"));
        assertThat(errors("INTERNAL_CALL_SERVICES", "broken")).hasSize(1);
        assertThat(errors("INTERNAL_CALL_SERVICES", "a:9001:8080:127.0.0.3,b:9002:8081:127.0.0.3")).hasSize(1);
        assertThat(errors("INTERNAL_CALL_SERVICES", "")).isEmpty();
    }

    @Test
    void foldersAndPaths() {
        assertThat(errors("ALFRED_LOGS_WATCH_DIRS", "wildfly:/opt/wildfly/standalone/log,app:C:\\logs\\app")).isEmpty();
        assertThat(errors("ALFRED_LOGS_WATCH_DIRS", "a:/x,a:/y")).hasSize(1);
        assertThat(errors("ALFRED_LOGS_WATCH_DIRS", "a:/x,b:/x")).hasSize(1);
        assertThat(errors("ALFRED_LOGS_WATCH_DIRS", "bad name:/x")).hasSize(1);
        assertThat(errors("ALFRED_LOGS_WATCH_DIRS", "a:relative/x")).hasSize(1);
        assertThat(errors("ALFRED_LOGS_DIR", "./logs-drop")).isEmpty();
        assertThat(errors("ALFRED_LOGS_DIR", "logs-drop")).hasSize(1);
        assertThat(errors("ALFRED_LOGS_DIR", "")).hasSize(1);
        assertThat(errors("WILDFLY_HOME", "")).isEmpty();
    }

    @Test
    void whoMayChangeSettings() {
        assertThat(errors("ALFRED_SETTINGS_EDIT_FROM", "local,lan,192.168.1.0/24")).isEmpty();
        assertThat(errors("ALFRED_SETTINGS_EDIT_FROM", "local,everyone")).hasSize(1);
        assertThat(SettingsValidator.validate(Map.of("ALFRED_SETTINGS_EDIT_FROM", "lan"), Set.of("ALFRED_SETTINGS_EDIT_FROM")))
                .singleElement().satisfies(r -> assertThat(r.level()).isEqualTo(ValidationResult.Level.WARNING));
    }

    @Test
    void unknownKeysAreRefused() {
        assertThat(errors("NOT_A_SETTING", "x")).singleElement().satisfies(r -> assertThat(r.message()).isEqualTo("not a setting"));
    }
}
