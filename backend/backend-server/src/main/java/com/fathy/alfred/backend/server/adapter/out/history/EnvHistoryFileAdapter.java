package com.fathy.alfred.backend.server.adapter.out.history;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.server.application.port.out.HistoryPort;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

/**
 * .env history (FR-034): one JSON line per change in data/env-history.jsonl, plus the .env content before and after it
 * under data/env-history/. The last {@value #KEEP} entries are kept; older lines and their snapshots are deleted when a
 * new one is appended (Constitution II: every store has a retention). Secret values never get here: the service
 * records them as "set"/"changed", and snapshots are written owner-only like .env itself.
 *
 * <p>Plain class (no Spring annotations): ServerConfigCli uses it without a Spring context.
 */
public class EnvHistoryFileAdapter implements HistoryPort {

    static final int KEEP = 50;
    private static final Logger log = LoggerFactory.getLogger(EnvHistoryFileAdapter.class);

    private final Path file;
    private final Path snapshots;
    private final ObjectMapper mapper;
    private final Clock clock;

    public EnvHistoryFileAdapter(Path dataDir, ObjectMapper mapper, Clock clock) {
        this.file = dataDir.resolve("env-history.jsonl");
        this.snapshots = dataDir.resolve("env-history");
        this.mapper = mapper;
        this.clock = clock;
    }

    @Override
    public synchronized long append(HistoryEntry.HistorySource source, String sourceDetail, List<HistoryEntry.Change> changes,
                                    String contentBefore, String contentAfter) {
        try {
            Files.createDirectories(snapshots);
            List<JsonNode> lines = readLines();
            long id = lines.isEmpty() ? 1 : lines.get(lines.size() - 1).path("id").asLong() + 1;
            Instant at = clock.instant();
            String before = "before-" + id + ".env";
            String after = "after-" + id + ".env";
            writeOwnerOnly(snapshots.resolve(before), contentBefore);
            writeOwnerOnly(snapshots.resolve(after), contentAfter);

            ObjectNode node = mapper.createObjectNode();
            node.put("id", id);
            node.put("at", at.toString());
            node.put("source", source.name());
            node.put("sourceDetail", sourceDetail);
            ArrayNode array = node.putArray("changes");
            for (HistoryEntry.Change change : changes) {
                ObjectNode c = array.addObject();
                c.put("key", change.key());
                c.put("before", change.before());
                c.put("after", change.after());
            }
            node.put("snapshotFile", before);
            node.put("afterFile", after);
            lines.add(node);
            prune(lines);
            return id;
        } catch (IOException e) {
            log.error("Could not record .env history in {}", file, e);
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public synchronized List<HistoryEntry> recent(int limit) {
        List<JsonNode> lines = readLines();
        List<HistoryEntry> out = new ArrayList<>();
        for (int i = lines.size() - 1; i >= 0 && out.size() < limit; i--) {
            out.add(toEntry(lines.get(i)));
        }
        return out;
    }

    @Override
    public synchronized Optional<HistoryEntry> find(long id) {
        return readLines().stream().filter(n -> n.path("id").asLong() == id).findFirst().map(this::toEntry);
    }

    @Override
    public synchronized Optional<String> contentBefore(long id) {
        return readLines().stream().filter(n -> n.path("id").asLong() == id).findFirst()
                .flatMap(n -> read(snapshots.resolve(n.path("snapshotFile").asText())));
    }

    @Override
    public synchronized Optional<String> lastKnownContent() {
        List<JsonNode> lines = readLines();
        if (lines.isEmpty()) {
            return Optional.empty();
        }
        return read(snapshots.resolve(lines.get(lines.size() - 1).path("afterFile").asText()));
    }

    private HistoryEntry toEntry(JsonNode n) {
        List<HistoryEntry.Change> changes = new ArrayList<>();
        n.path("changes").forEach(c -> changes.add(new HistoryEntry.Change(c.path("key").asText(),
                c.path("before").isNull() ? null : c.path("before").asText(),
                c.path("after").isNull() ? null : c.path("after").asText())));
        return new HistoryEntry(n.path("id").asLong(), Instant.parse(n.path("at").asText()),
                HistoryEntry.HistorySource.valueOf(n.path("source").asText()),
                n.path("sourceDetail").isNull() ? null : n.path("sourceDetail").asText(), changes, n.path("snapshotFile").asText());
    }

    private List<JsonNode> readLines() {
        if (!Files.isRegularFile(file)) {
            return new ArrayList<>();
        }
        try {
            List<JsonNode> out = new ArrayList<>();
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (!line.isBlank()) {
                    out.add(mapper.readTree(line));
                }
            }
            return out;
        } catch (IOException e) {
            log.error("Could not read .env history {}", file, e);
            return new ArrayList<>();
        }
    }

    /** Keeps the newest KEEP lines; deletes the snapshots of the dropped ones. The file is tiny (KEEP lines). */
    private void prune(List<JsonNode> lines) throws IOException {
        List<JsonNode> dropped = lines.size() > KEEP ? new ArrayList<>(lines.subList(0, lines.size() - KEEP)) : Collections.emptyList();
        List<JsonNode> kept = lines.subList(Math.max(0, lines.size() - KEEP), lines.size());
        StringBuilder text = new StringBuilder();
        for (JsonNode node : kept) {
            text.append(mapper.writeValueAsString(node)).append('\n');
        }
        Path temp = file.resolveSibling(file.getFileName() + ".tmp");
        writeOwnerOnly(temp, text.toString());
        Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        for (JsonNode node : dropped) {
            Files.deleteIfExists(snapshots.resolve(node.path("snapshotFile").asText()));
            Files.deleteIfExists(snapshots.resolve(node.path("afterFile").asText()));
        }
    }

    private static void writeOwnerOnly(Path path, String content) throws IOException {
        Files.writeString(path, content, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE);
        try {
            Files.setPosixFilePermissions(path, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException ignored) {
            // Windows: the data folder's owner-only ACL, set by the installer, applies.
        }
    }

    private static Optional<String> read(Path path) {
        try {
            return Files.isRegularFile(path) ? Optional.of(Files.readString(path, StandardCharsets.UTF_8)) : Optional.empty();
        } catch (IOException e) {
            return Optional.empty();
        }
    }
}
