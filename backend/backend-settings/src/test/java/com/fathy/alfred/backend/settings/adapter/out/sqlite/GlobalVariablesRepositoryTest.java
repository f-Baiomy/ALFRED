package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.domain.model.GlobalVariablesState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class GlobalVariablesRepositoryTest {

    @TempDir
    Path tempDir;

    private final List<GlobalVariablesRepository> opened = new ArrayList<>();
    private final ObjectMapper mapper = new ObjectMapper();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(GlobalVariablesRepository::close);
        Thread.sleep(50);
    }

    private GlobalVariablesRepository repositoryFor(Path dbFile, Path variablesFile) throws Exception {
        GlobalVariablesRepository repository = new GlobalVariablesRepository();
        Field dbField = GlobalVariablesRepository.class.getDeclaredField("dbFile");
        dbField.setAccessible(true);
        dbField.set(repository, dbFile.toString());
        Field variablesField = GlobalVariablesRepository.class.getDeclaredField("variablesFile");
        variablesField.setAccessible(true);
        variablesField.set(repository, variablesFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    /** Builds a full nested state with one environment ("Default") holding the given fields. */
    private static Map<String, Object> stateWith(Map<String, String> variables, Map<String, String> fallbacks, Map<String, Long> updatedAt) {
        Map<String, Object> env = GlobalVariablesState.newEnvironment(variables, fallbacks, updatedAt, Map.of());
        return Map.of("activeEnvironment", "Default", "environments", Map.of("Default", env), "secrets", List.of());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> defaultEnvOf(Map<String, Object> state) {
        Map<String, Object> environments = (Map<String, Object>) state.get("environments");
        return (Map<String, Object>) environments.get("Default");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> variablesOf(Map<String, Object> state) {
        return (Map<String, Object>) defaultEnvOf(state).get("variables");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> updatedAtOf(Map<String, Object> state) {
        return (Map<String, Object>) defaultEnvOf(state).get("updatedAt");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sourcesOf(Map<String, Object> state) {
        return (Map<String, Object>) defaultEnvOf(state).get("sources");
    }

    private void writeFile(Path variablesFile, String json) throws Exception {
        Files.createDirectories(variablesFile.getParent());
        Files.writeString(variablesFile, json);
    }

    @Test
    void loadMigratesALegacyFlatDatabaseStateToOneDefaultEnvironment() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        Map<String, Object> loaded = repo.load();
        assertThat(loaded.get("activeEnvironment")).isEqualTo("Default");
        assertThat(variablesOf(loaded)).isEmpty();
    }

    @Test
    void loadAbsorbsAFilePromotionNewerThanTheEnvironmentsUpdatedAt() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        writeFile(variablesFile,
                "{\"environment\":\"Default\",\"variables\":{\"message\":\"Session has been expired\"},"
                        + "\"fallbacks\":{},\"promotedAt\":{\"message\":5000},"
                        + "\"promotedBy\":{\"message\":{\"ruleId\":\"r-1\",\"ruleName\":\"Login\"}}}");

        Map<String, Object> loaded = repo.load();
        assertThat(variablesOf(loaded)).containsEntry("message", "Session has been expired");
        assertThat(((Number) updatedAtOf(loaded).get("message")).longValue()).isEqualTo(5000L);
        assertThat(sourcesOf(loaded).get("message")).isEqualTo(
                Map.of("kind", "CAPTURE", "ruleId", "r-1", "ruleName", "Login"));

        // Absorbed into SQLite: still there after the file is gone.
        Files.delete(variablesFile);
        assertThat(variablesOf(repo.load())).containsEntry("message", "Session has been expired");
    }

    @Test
    void olderOrMissingPromotedAtIsIgnored() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(stateWith(Map.of("token", "FROM-UI"), Map.of(), Map.of("token", 10_000L)));

        // A file write with an older promotedAt must not revert the newer DB value.
        writeFile(variablesFile, "{\"environment\":\"Default\",\"variables\":{\"token\":\"STALE\"},\"fallbacks\":{},\"promotedAt\":{\"token\":1000}}");
        assertThat(variablesOf(repo.load())).containsEntry("token", "FROM-UI");

        // A file write with no promotedAt at all is ignored too.
        writeFile(variablesFile, "{\"environment\":\"Default\",\"variables\":{\"token\":\"STALE-NO-TIMESTAMP\"},\"fallbacks\":{}}");
        assertThat(variablesOf(repo.load())).containsEntry("token", "FROM-UI");
    }

    @Test
    void newerPromotedAtOverridesAnOlderDbValue() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(stateWith(Map.of("token", "OLD"), Map.of(), Map.of("token", 1000L)));

        writeFile(variablesFile, "{\"environment\":\"Default\",\"variables\":{\"token\":\"NEW\"},\"fallbacks\":{},\"promotedAt\":{\"token\":5000}}");
        Map<String, Object> loaded = repo.load();
        assertThat(variablesOf(loaded)).containsEntry("token", "NEW");
        assertThat(updatedAtOf(loaded)).containsEntry("token", 5000L);
    }

    @Test
    void deletedNameIsNotResurrectedByAStaleFileWrite() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        // Simulate: the name was once promoted at t=1000, then deleted by the UI at t=9000 (a
        // tombstone - gone from variables, but updatedAt remembers when it was last touched).
        repo.save(stateWith(Map.of(), Map.of(), Map.of("token", 9000L)));

        // The file still holds the old promotion, timestamped before the deletion.
        writeFile(variablesFile, "{\"environment\":\"Default\",\"variables\":{\"token\":\"OLD-PROMOTED-VALUE\"},\"fallbacks\":{},\"promotedAt\":{\"token\":1000}}");
        assertThat(variablesOf(repo.load())).doesNotContainKey("token");
    }

    @Test
    void aFileNamingAnUnknownEnvironmentIsIgnored() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);

        writeFile(variablesFile, "{\"environment\":\"Deleted\",\"variables\":{\"token\":\"x\"},\"fallbacks\":{},\"promotedAt\":{\"token\":5000}}");
        Map<String, Object> loaded = repo.load();
        assertThat(variablesOf(loaded)).doesNotContainKey("token");
    }

    @Test
    void invalidFileEntriesAreSkippedNeverThrown() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        writeFile(variablesFile,
                "{\"environment\":\"Default\",\"variables\":{\"good\":\"yes\",\"this.local\":\"no\",\"1bad\":\"no\",\"num\":42},\"fallbacks\":{},"
                        + "\"promotedAt\":{\"good\":5000,\"this.local\":5000,\"1bad\":5000,\"num\":5000}}");

        assertThat(variablesOf(repo.load())).containsExactly(Map.entry("good", "yes"));
    }

    @Test
    void missingOrCorruptFileLoadsDatabaseState() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(stateWith(Map.of("kept", "v"), Map.of(), Map.of()));
        Files.deleteIfExists(variablesFile);

        assertThat(variablesOf(repo.load())).containsEntry("kept", "v");

        Files.writeString(variablesFile, "not json{{{");
        assertThat(variablesOf(repo.load())).containsEntry("kept", "v");
    }

    @Test
    void updateSkipsWriteAndPublishWhenNothingChanges() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(stateWith(Map.of("kept", "v"), Map.of(), Map.of()));
        long publishedAt = Files.getLastModifiedTime(variablesFile).toMillis();
        Thread.sleep(20);

        GlobalVariablesStorePort.Update result = repo.update(current -> current);

        assertThat(result.changed()).isFalse();
        assertThat(Files.getLastModifiedTime(variablesFile).toMillis()).isEqualTo(publishedAt);
    }

    @Test
    void updateWritesAndPublishesWhenChanged() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);

        GlobalVariablesStorePort.Update result = repo.update(current -> stateWith(Map.of("added", "v"), Map.of(), Map.of("added", 1L)));

        assertThat(result.changed()).isTrue();
        assertThat(variablesOf(result.state())).containsEntry("added", "v");
        assertThat(variablesOf(repo.load())).containsEntry("added", "v");
    }

    @Test
    void publishedFileIsTheFlatActiveEnvironmentView() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(stateWith(Map.of("token", "v"), Map.of(), Map.of("token", 1L)));

        Map<String, Object> published = mapper.readValue(variablesFile.toFile(), Map.class);
        assertThat(published.get("environment")).isEqualTo("Default");
        assertThat(published.get("variables")).isEqualTo(Map.of("token", "v"));
        assertThat(published).containsKey("secrets");
    }
}
