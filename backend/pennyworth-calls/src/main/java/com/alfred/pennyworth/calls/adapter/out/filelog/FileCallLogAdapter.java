package com.alfred.pennyworth.calls.adapter.out.filelog;

import com.alfred.pennyworth.calls.application.port.out.CallLogPort;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the proxy's JSON-lines log file. This is the only place in the app that knows calls live
 * in a flat file - swapping to a different storage (Redis, MySQL, ...) later means writing a new
 * CallLogPort implementation with its own {@code havingValue}, not touching CallsService or
 * anything upstream of the port. {@code matchIfMissing = true} keeps this the default so existing
 * deployments (no {@code alfred.storage.calls.type} set) behave exactly as before.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.calls", name = "type", havingValue = "file", matchIfMissing = true)
public class FileCallLogAdapter implements CallLogPort {

    private static final Logger log = LoggerFactory.getLogger(FileCallLogAdapter.class);

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${LOG_FILE:/data/calls.log}")
    private String logFile;

    @Override
    public List<CallRecord> readAll() {
        Path path = Path.of(logFile);
        if (!Files.exists(path)) {
            return List.of();
        }

        List<String> lines;
        try {
            lines = Files.readAllLines(path);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to read call log at " + path, e);
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
                log.warn("Skipping malformed call log line in {}: {}", path, e.getMessage());
            }
        }
        return calls;
    }
}
