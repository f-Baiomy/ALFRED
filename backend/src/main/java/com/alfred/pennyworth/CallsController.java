package com.alfred.pennyworth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * pennyworth - Alfred's backend.
 *
 * Minimal starting point: reads the proxy's JSON-lines log file and exposes
 * it over a small HTTP API for the frontend (manor) to consume.
 *
 * This is intentionally bare - endpoints/filters/pagination/etc. to be
 * built out once the actual requirements are discussed.
 */
@RestController
public class CallsController {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${LOG_FILE:/data/calls.log}")
    private String logFile;

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok");
    }

    /**
     * Returns the most recent `limit` logged calls, newest first.
     */
    @GetMapping("/calls")
    public List<JsonNode> listCalls(@RequestParam(defaultValue = "50") int limit) throws IOException {
        Path path = Path.of(logFile);
        if (!Files.exists(path)) {
            return List.of();
        }

        List<String> lines = Files.readAllLines(path);
        int fromIndex = Math.max(0, lines.size() - limit);
        List<String> recent = new ArrayList<>(lines.subList(fromIndex, lines.size()));
        Collections.reverse(recent);

        List<JsonNode> calls = new ArrayList<>();
        for (String line : recent) {
            line = line.strip();
            if (line.isEmpty()) {
                continue;
            }
            try {
                calls.add(objectMapper.readTree(line));
            } catch (IOException e) {
                // malformed line - skip it, same as the previous implementation
            }
        }
        return calls;
    }
}
