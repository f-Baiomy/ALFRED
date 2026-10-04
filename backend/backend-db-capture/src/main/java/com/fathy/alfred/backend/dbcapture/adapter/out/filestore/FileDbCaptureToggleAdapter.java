package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureTogglePort;
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
 * The per-project capture switch: proxy/db-capture-enabled.flag, bind-mounted into reverse-proxy (which reads it to
 * decide the {@code db=} part of X-Alfred-Call) and here. Same "name=on|off" line format and same
 * re-read-on-every-call behaviour as backend-internal-calls' FileLoggingToggleAdapter - a human-driven, low-frequency
 * setting, and the proxy edits nothing here so there is nothing to cache against. The one difference: a project
 * with no line is OFF.
 */
@Component
public class FileDbCaptureToggleAdapter implements DbCaptureTogglePort {

    private static final Logger log = LoggerFactory.getLogger(FileDbCaptureToggleAdapter.class);

    @Value("${DB_CAPTURE_TOGGLE_FILE:/appdata/db-capture-enabled.flag}")
    private String toggleFile;

    @Override
    public boolean isEnabled(String project) {
        return readStates().getOrDefault(project, false);
    }

    @Override
    public synchronized void setEnabled(String project, boolean enabled) {
        Map<String, Boolean> states = readStates();
        states.put(project, enabled);
        StringBuilder content = new StringBuilder();
        states.forEach((name, on) -> content.append(name).append('=').append(on ? "on" : "off").append('\n'));
        Path path = Path.of(toggleFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, content.toString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            log.error("Failed to write {}: {}", toggleFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    private Map<String, Boolean> readStates() {
        Path path = Path.of(toggleFile);
        Map<String, Boolean> states = new LinkedHashMap<>();
        if (!Files.isRegularFile(path)) {
            return states;
        }
        List<String> lines;
        try {
            lines = Files.readAllLines(path);
        } catch (IOException e) {
            log.warn("Could not read {}, treating every project as off: {}", toggleFile, e.getMessage());
            return states;
        }
        for (String line : lines) {
            String trimmed = line.strip();
            int eq = trimmed.indexOf('=');
            if (trimmed.isEmpty() || eq < 0) {
                continue;
            }
            states.put(trimmed.substring(0, eq).strip(), !trimmed.substring(eq + 1).strip().toLowerCase(Locale.ROOT).equals("off"));
        }
        return states;
    }
}
