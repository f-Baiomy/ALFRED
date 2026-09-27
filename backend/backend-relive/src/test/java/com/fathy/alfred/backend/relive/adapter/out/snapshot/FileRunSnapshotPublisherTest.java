package com.fathy.alfred.backend.relive.adapter.out.snapshot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class FileRunSnapshotPublisherTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private FileRunSnapshotPublisher publisher;
    private Path reliveDir;

    @BeforeEach
    void setUp(@TempDir Path tempDir) {
        Path rulesFile = tempDir.resolve("interception/rules.json");
        publisher = new FileRunSnapshotPublisher(objectMapper);
        ReflectionTestUtils.setField(publisher, "rulesFile", rulesFile.toString());
        reliveDir = tempDir.resolve("interception").resolve("relive");
    }

    @Test
    void publishWritesTheSnapshotFileAtomically() throws Exception {
        JsonNode snapshot = objectMapper.createObjectNode().put("runId", "r-1");
        publisher.publish("r-1", snapshot);

        Path file = reliveDir.resolve("r-1.json");
        assertThat(Files.exists(file)).isTrue();
        try (var files = Files.list(reliveDir)) {
            assertThat(files.noneMatch(p -> p.getFileName().toString().endsWith(".tmp"))).isTrue();
        }
    }

    @Test
    void unpublishDeletesTheSnapshotAndItsAnswersDirectory() throws Exception {
        publisher.publish("r-1", objectMapper.createObjectNode());
        publisher.writeAnswer("r-1", "8f0c1234-0000-4000-8000-000000000000", objectMapper.createObjectNode(), "body".getBytes());
        assertThat(Files.exists(reliveDir.resolve("r-1.json"))).isTrue();
        assertThat(Files.isDirectory(reliveDir.resolve("answers").resolve("r-1"))).isTrue();

        publisher.unpublish("r-1");

        assertThat(Files.exists(reliveDir.resolve("r-1.json"))).isFalse();
        assertThat(Files.exists(reliveDir.resolve("answers").resolve("r-1"))).isFalse();
    }

    @Test
    void publishInflightAndClearInflightRoundTrip() {
        publisher.publishInflight(objectMapper.createObjectNode().put("at", 123));
        assertThat(Files.exists(reliveDir.resolve("inflight.json"))).isTrue();

        publisher.clearInflight();
        assertThat(Files.exists(reliveDir.resolve("inflight.json"))).isFalse();
    }

    @Test
    void writeAnswerIsWrittenOnceAndNeverOverwritten() throws Exception {
        publisher.writeAnswer("r-1", "8f0c1234-0000-4000-8000-000000000000", objectMapper.createObjectNode().put("v", 1), "first".getBytes());
        publisher.writeAnswer("r-1", "8f0c1234-0000-4000-8000-000000000000", objectMapper.createObjectNode().put("v", 2), "second".getBytes());

        Path body = reliveDir.resolve("answers").resolve("r-1").resolve("8f0c1234-0000-4000-8000-000000000000.body");
        assertThat(Files.readString(body)).isEqualTo("first");
    }

    @Test
    void rejectsAnInvalidRunIdWithoutThrowing() {
        publisher.publish("../../etc/passwd", objectMapper.createObjectNode());
        assertThat(Files.exists(reliveDir)).isFalse();
    }
}
