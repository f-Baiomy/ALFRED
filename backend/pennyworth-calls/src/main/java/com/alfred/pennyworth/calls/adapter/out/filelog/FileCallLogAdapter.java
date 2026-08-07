package com.alfred.pennyworth.calls.adapter.out.filelog;

import com.alfred.pennyworth.calls.application.port.out.CallLogPort;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;

/**
 * Owns RECENT_CALLS.log end to end - the proxy only calls the webhook now, it no longer writes
 * any file itself; this is the only place in the app that knows calls live in a flat file -
 * swapping to a different storage (Redis, MySQL, ...) later means writing a new CallLogPort
 * implementation with its own {@code havingValue}, not touching CallsService or anything
 * upstream of the port. {@code matchIfMissing = true} keeps this the default so existing
 * deployments (no {@code alfred.storage.calls.type} set) behave exactly as before.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.calls", name = "type", havingValue = "file", matchIfMissing = true)
public class FileCallLogAdapter implements CallLogPort {

    private static final Logger log = LoggerFactory.getLogger(FileCallLogAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${RECENT_CALLS_FILE:/appdata/RECENT_CALLS.log}")
    private String recentCallsFile;

    /** Fail fast with a clear message if the directory isn't writable, rather than only discovering it on the first webhook call. */
    @PostConstruct
    void checkStorageIsWritable() {
        Path path = Path.of(recentCallsFile);
        Path parent = path.getParent();
        if (parent == null) {
            return;
        }
        try {
            Files.createDirectories(parent);
            if (!Files.isWritable(parent)) {
                log.error("Recent-calls directory {} is not writable - saving new calls will fail", parent);
            }
        } catch (IOException e) {
            log.error("Could not create recent-calls directory {}: {}", parent, e.getMessage());
        }
    }

    @Override
    public List<CallRecord> readAll() {
        Path path = Path.of(recentCallsFile);
        if (!Files.exists(path)) {
            return List.of();
        }

        List<String> lines;
        try {
            lines = Files.readAllLines(path);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read " + path, e);
        }

        List<CallRecord> calls = new ArrayList<>();
        for (String line : lines) {
            String trimmed = line.strip();
            if (trimmed.isEmpty()) {
                continue;
            }
            try {
                calls.add(objectMapper.readValue(trimmed, CallRecord.class));
            } catch (IOException e) {
                log.warn("Skipping malformed line in {}: {}", path, e.getMessage());
            }
        }
        return calls;
    }

    @Override
    public void save(CallRecord call) {
        Path path = Path.of(recentCallsFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            String line = objectMapper.writeValueAsString(call) + System.lineSeparator();
            Files.writeString(path, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("Failed to append to {}: {}", recentCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
