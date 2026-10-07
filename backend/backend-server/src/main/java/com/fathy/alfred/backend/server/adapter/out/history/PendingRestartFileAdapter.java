package com.fathy.alfred.backend.server.adapter.out.history;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.server.application.port.out.PendingRestartPort;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** data/pending-restart.json: saved RESTART settings not in effect yet. A few lines at most. */
public class PendingRestartFileAdapter implements PendingRestartPort {

    private static final Logger log = LoggerFactory.getLogger(PendingRestartFileAdapter.class);

    private final Path file;
    private final ObjectMapper mapper;

    public PendingRestartFileAdapter(Path dataDir, ObjectMapper mapper) {
        this.file = dataDir.resolve("pending-restart.json");
        this.mapper = mapper;
    }

    @Override
    public synchronized List<PendingRestart> all() {
        if (!Files.isRegularFile(file)) {
            return List.of();
        }
        try {
            List<Map<String, String>> rows = mapper.readValue(file.toFile(), new TypeReference<>() { });
            List<PendingRestart> out = new ArrayList<>();
            for (Map<String, String> row : rows) {
                out.add(new PendingRestart(row.get("key"), row.get("before"), row.get("after"), Instant.parse(row.get("savedAt"))));
            }
            return out;
        } catch (IOException | RuntimeException e) {
            log.warn("Ignoring unreadable {}: {}", file, e.getMessage());
            return List.of();
        }
    }

    @Override
    public synchronized void replace(List<PendingRestart> pending) {
        try {
            Files.createDirectories(file.getParent());
            List<Map<String, String>> rows = pending.stream().map(p -> Map.of(
                    "key", p.key(), "before", String.valueOf(p.before()), "after", String.valueOf(p.after()),
                    "savedAt", p.savedAt().toString())).toList();
            Path temp = file.resolveSibling(file.getFileName() + ".tmp");
            mapper.writeValue(temp.toFile(), rows);
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.error("Could not write {}", file, e);
            throw new UncheckedIOException(e);
        }
    }
}
