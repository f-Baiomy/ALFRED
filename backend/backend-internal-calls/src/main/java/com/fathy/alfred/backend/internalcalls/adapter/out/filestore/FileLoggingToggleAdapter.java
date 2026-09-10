package com.fathy.alfred.backend.internalcalls.adapter.out.filestore;

import com.fathy.alfred.backend.internalcalls.application.port.out.LoggingTogglePort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads/writes the exact same flag file proxy/log_and_route_reverse.py polls (via mtime) and
 * toggle-wildfly-reverse-proxy.sh/.bat already edit by hand - see docker-compose.yml's
 * reverse-proxy AND backend services, both of which bind-mount ./proxy/reverse-proxy-enabled.flag
 * (at different in-container paths). One "name=on"/"name=off" line per project; a name with no
 * line yet defaults to enabled (mirrors log_and_route_reverse.py's _ToggleState exactly). This
 * adapter is just a third way to flip the same file; it doesn't own the file any more than the
 * shell scripts do, so it re-reads on every call rather than caching - this is a low-frequency,
 * human-driven setting, not a hot path.
 */
@Component
public class FileLoggingToggleAdapter implements LoggingTogglePort {

    private static final Logger log = LoggerFactory.getLogger(FileLoggingToggleAdapter.class);

    @Value("${REVERSE_PROXY_TOGGLE_FILE:/appdata/reverse-proxy-enabled.flag}")
    private String toggleFile;

    @Override
    public boolean isEnabled(String name) {
        return readStates().getOrDefault(name, true);
    }

    @Override
    public void setEnabled(String name, boolean enabled) {
        Map<String, Boolean> states = readStates();
        states.put(name, enabled);
        writeStates(states);
    }

    private Map<String, Boolean> readStates() {
        Path path = Path.of(toggleFile);
        Map<String, Boolean> states = new LinkedHashMap<>();
        if (!Files.exists(path)) {
            return states;
        }
        List<String> lines;
        try {
            lines = Files.readAllLines(path);
        } catch (IOException e) {
            log.warn("Could not read {}, treating every name as enabled: {}", toggleFile, e.getMessage());
            return states;
        }
        for (String line : lines) {
            String trimmed = line.strip();
            int eq = trimmed.indexOf('=');
            if (trimmed.isEmpty() || eq < 0) {
                continue;
            }
            String lineName = trimmed.substring(0, eq).strip();
            String value = trimmed.substring(eq + 1).strip().toLowerCase(Locale.ROOT);
            states.put(lineName, !value.equals("off"));
        }
        return states;
    }

    private void writeStates(Map<String, Boolean> states) {
        Path path = Path.of(toggleFile);
        StringBuilder content = new StringBuilder();
        for (Map.Entry<String, Boolean> entry : states.entrySet()) {
            content.append(entry.getKey()).append('=').append(entry.getValue() ? "on" : "off").append('\n');
        }
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, content.toString(),
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            log.error("Failed to write {}: {}", toggleFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
