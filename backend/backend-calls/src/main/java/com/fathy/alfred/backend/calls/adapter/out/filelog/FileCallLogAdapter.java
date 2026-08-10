package com.fathy.alfred.backend.calls.adapter.out.filelog;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
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

    /** Same property CallsService clamps GET /calls with - kept in sync by construction since both read the one property. */
    @Value("${alfred.calls.max-limit:200}")
    private int maxLimit;

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

    /**
     * RECENT_CALLS.log is a ring buffer, not an unbounded append log: once it holds maxLimit
     * calls, adding one more drops the oldest line first. That means every save is a full
     * read-modify-write rather than a cheap append - fine at maxLimit's scale (default 200) -
     * and synchronized so concurrent webhook calls can't interleave their read-modify-write and
     * lose an entry.
     */
    @Override
    public synchronized void save(CallRecord call) {
        Path path = Path.of(recentCallsFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            List<String> lines = Files.exists(path) ? new ArrayList<>(Files.readAllLines(path)) : new ArrayList<>();
            lines.removeIf(String::isBlank);
            lines.add(objectMapper.writeValueAsString(call));
            if (lines.size() > maxLimit) {
                lines = lines.subList(lines.size() - maxLimit, lines.size());
            }
            String content = String.join(System.lineSeparator(), lines) + System.lineSeparator();
            Files.writeString(path, content, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            log.error("Failed to save to {}: {}", recentCallsFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
