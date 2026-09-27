package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
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

    @SuppressWarnings("unchecked")
    private static Map<String, Object> variablesOf(Map<String, Object> state) {
        return (Map<String, Object>) state.get("variables");
    }

    private void writeFile(Path variablesFile, String json) throws Exception {
        Files.createDirectories(variablesFile.getParent());
        Files.writeString(variablesFile, json);
    }

    @Test
    void loadAbsorbsProxyPromotedValuesFromTheFile() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        writeFile(variablesFile, "{\"variables\":{\"message\":\"Session has been expired\"},\"fallbacks\":{}}");

        assertThat(variablesOf(repo.load())).containsEntry("message", "Session has been expired");

        // Absorbed into SQLite: still there after the file is gone.
        Files.delete(variablesFile);
        assertThat(variablesOf(repo.load())).containsEntry("message", "Session has been expired");
    }

    @Test
    void fileWinsOnConflictAndUiDeletionsStillWork() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(Map.of("variables", Map.of("token", "OLD"), "fallbacks", Map.of()));
        writeFile(variablesFile, "{\"variables\":{\"token\":\"NEW\"},\"fallbacks\":{}}");

        assertThat(variablesOf(repo.load())).containsEntry("token", "NEW");

        // A UI save republishes the file, so a key the UI drops stays dropped.
        repo.save(Map.of("variables", Map.of(), "fallbacks", Map.of()));
        assertThat(variablesOf(repo.load())).isEmpty();
        assertThat(variablesOf(mapper.readValue(variablesFile.toFile(), Map.class))).isEmpty();
    }

    @Test
    void invalidFileEntriesAreSkippedNeverThrown() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        writeFile(variablesFile, "{\"variables\":{\"good\":\"yes\",\"this.local\":\"no\",\"1bad\":\"no\",\"num\":42},\"fallbacks\":{}}");

        assertThat(variablesOf(repo.load())).containsExactly(Map.entry("good", "yes"));
    }

    @Test
    void missingOrCorruptFileLoadsDatabaseState() throws Exception {
        Path variablesFile = tempDir.resolve("interception").resolve("variables.json");
        GlobalVariablesRepository repo = repositoryFor(tempDir.resolve("settings.db"), variablesFile);
        repo.save(Map.of("variables", Map.of("kept", "v"), "fallbacks", Map.of()));
        Files.deleteIfExists(variablesFile);

        assertThat(variablesOf(repo.load())).containsEntry("kept", "v");

        Files.writeString(variablesFile, "not json{{{");
        assertThat(variablesOf(repo.load())).containsEntry("kept", "v");
    }
}
