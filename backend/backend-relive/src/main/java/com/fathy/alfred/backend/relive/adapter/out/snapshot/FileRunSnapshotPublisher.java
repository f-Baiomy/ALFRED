package com.fathy.alfred.backend.relive.adapter.out.snapshot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.regex.Pattern;

/**
 * Writes the per-run proxy snapshot (contracts/proxy-snapshot.md) and the shared
 * {@code inflight.json} the addons read. Same directory as interception's own rules snapshot -
 * {@code INTERCEPTION_RULES_FILE}'s parent - so it is already bind-mounted into both proxy
 * containers (see {@code FileRulesPublisherAdapter}'s identical rationale); {@code relive/} is a
 * subdirectory of it, never a sibling env var of its own.
 *
 * <p>Every write here is atomic (temp file + move), for the same reason as
 * {@code FileRulesPublisherAdapter}: a reader catching a half-written run snapshot mid-write would
 * see a corrupt file and - per the addon's own safety rule - fail closed, which for a Relive run
 * means blocking calls that should have replayed. A brief window of "still the previous snapshot"
 * is always the better failure than "unparseable snapshot".
 */
@Component
public class FileRunSnapshotPublisher implements RunSnapshotPublisherPort {

    private static final Logger log = LoggerFactory.getLogger(FileRunSnapshotPublisher.class);
    private static final Pattern RUN_ID = Pattern.compile("[A-Za-z0-9_-]{1,100}");
    private static final Pattern ANSWER_ID = Pattern.compile("[A-Za-z0-9_-]{1,100}");

    private final ObjectMapper objectMapper;

    @Value("${INTERCEPTION_RULES_FILE:/appdata/interception/rules.json}")
    private String rulesFile;

    public FileRunSnapshotPublisher(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    private Path reliveDir() {
        return Path.of(rulesFile).toAbsolutePath().getParent().resolve("relive");
    }

    @Override
    public synchronized void publish(String runId, JsonNode snapshotJson) {
        if (!RUN_ID.matcher(runId).matches()) {
            log.warn("Not publishing a run snapshot with an invalid run id");
            return;
        }
        try {
            Path dir = reliveDir();
            Files.createDirectories(dir);
            writeAtomically(dir, dir.resolve(runId + ".json"), objectMapper.writeValueAsBytes(snapshotJson));
        } catch (IOException e) {
            log.error("Could not publish the run snapshot for {} - the proxy is still running whatever it last had: {}", runId, e.getMessage());
        }
    }

    @Override
    public synchronized void unpublish(String runId) {
        if (!RUN_ID.matcher(runId).matches()) {
            return;
        }
        Path dir = reliveDir();
        try {
            Files.deleteIfExists(dir.resolve(runId + ".json"));
            Path answersDir = dir.resolve("answers").resolve(runId);
            if (Files.isDirectory(answersDir)) {
                try (var files = Files.walk(answersDir)) {
                    files.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (IOException ignored) {
                            // Best-effort cleanup - a leftover answer file costs disk, not correctness.
                        }
                    });
                }
            }
        } catch (IOException e) {
            log.warn("Could not fully unpublish run {}: {}", runId, e.getMessage());
        }
    }

    @Override
    public synchronized void publishInflight(JsonNode inflightJson) {
        try {
            Path dir = reliveDir();
            Files.createDirectories(dir);
            writeAtomically(dir, dir.resolve("inflight.json"), objectMapper.writeValueAsBytes(inflightJson));
        } catch (IOException e) {
            log.error("Could not publish inflight.json: {}", e.getMessage());
        }
    }

    @Override
    public synchronized void clearInflight() {
        try {
            Files.deleteIfExists(reliveDir().resolve("inflight.json"));
        } catch (IOException e) {
            log.warn("Could not clear inflight.json: {}", e.getMessage());
        }
    }

    @Override
    public synchronized void writeAnswer(String runId, String answerId, JsonNode meta, byte[] body) {
        if (!RUN_ID.matcher(runId).matches() || !ANSWER_ID.matcher(answerId).matches()) {
            log.warn("Not writing a relive answer file with an invalid run id or answer id");
            return;
        }
        try {
            Path dir = reliveDir().resolve("answers").resolve(runId);
            Files.createDirectories(dir);
            Path metaPath = dir.resolve(answerId + ".meta.json");
            if (Files.exists(metaPath)) {
                return; // answers are immutable, like the global answer store
            }
            writeAtomically(dir, dir.resolve(answerId + ".body"), body);
            writeAtomically(dir, metaPath, objectMapper.writeValueAsBytes(meta));
        } catch (IOException e) {
            log.error("Could not write relive answer {} for run {}: {}", answerId, runId, e.getMessage());
        }
    }

    private void writeAtomically(Path dir, Path target, byte[] content) throws IOException {
        Path temp = Files.createTempFile(dir, ".alfred", ".tmp");
        try {
            Files.write(temp, content);
            move(temp, target);
        } catch (IOException e) {
            Files.deleteIfExists(temp);
            throw e;
        }
    }

    private void move(Path temp, Path target) throws IOException {
        try {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
