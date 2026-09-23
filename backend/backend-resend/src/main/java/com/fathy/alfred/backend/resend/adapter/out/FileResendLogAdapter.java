package com.fathy.alfred.backend.resend.adapter.out;

import com.fathy.alfred.backend.resend.application.port.out.ResendLogPort;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;
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
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * File-based resend log: one JSON line per request/outcome, appended to resends.log.
 * No ring buffer - resend log grows unbounded (resends are rare vs. calls).
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.resends", name = "type", havingValue = "file")
public class FileResendLogAdapter implements ResendLogPort {
    private static final Logger log = LoggerFactory.getLogger(FileResendLogAdapter.class);
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${RESENDS_FILE:/appdata/resends.log}")
    private String resendsFile;

    @Override
    public void saveRequest(ResendRequest request) {
        append("request", request);
    }

    @Override
    public void saveOutcome(ResendOutcome outcome) {
        append("outcome", outcome);
    }

    private synchronized void append(String type, Object record) {
        Path path = Path.of(resends File);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            String line = objectMapper.writeValueAsString(record);
            Files.writeString(path, line + System.lineSeparator(), StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("Failed to append {} to {}: {}", type, resends File, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public Optional<ResendRequest> findRequest(String id) {
        return readLines().stream()
                .filter(line -> line.contains("\"id\"") && line.contains(id))
                .filter(line -> !line.contains("\"new_call_id\"")) // outcome, not request
                .map(line -> {
                    try {
                        return objectMapper.readValue(line, ResendRequest.class);
                    } catch (Exception e) {
                        return null;
                    }
                })
                .filter(req -> req != null && id.equals(req.id()))
                .findFirst();
    }

    @Override
    public Optional<ResendOutcome> findOutcomeByNewCallId(String newCallId) {
        return readLines().stream()
                .filter(line -> line.contains("\"new_call_id\"") && line.contains(newCallId))
                .map(line -> {
                    try {
                        return objectMapper.readValue(line, ResendOutcome.class);
                    } catch (Exception e) {
                        return null;
                    }
                })
                .filter(outcome -> outcome != null && newCallId.equals(outcome.newCallId()))
                .findFirst();
    }

    private List<String> readLines() {
        Path path = Path.of(resends File);
        if (!Files.exists(path)) {
            return List.of();
        }
        try {
            return Files.readAllLines(path);
        } catch (IOException e) {
            log.error("Failed to read {}: {}", resends File, e.getMessage());
            return List.of();
        }
    }
}
