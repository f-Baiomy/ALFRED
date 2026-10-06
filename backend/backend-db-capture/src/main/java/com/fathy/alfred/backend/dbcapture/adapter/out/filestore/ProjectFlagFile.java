package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
 * A per-project on/off flag file shared with the reverse proxy: one {@code name=on|off} line per project, a project with
 * no line is OFF. Read on every call - a human-driven, low-frequency setting the proxy only reads, so there is nothing
 * to cache against. The ◆ database-capture switch and the ▤ Logs switch are two files of this one format.
 */
final class ProjectFlagFile {

    private static final Logger log = LoggerFactory.getLogger(ProjectFlagFile.class);

    private ProjectFlagFile() {
    }

    static boolean isOn(String file, String project) {
        return read(file).getOrDefault(project, false);
    }

    static synchronized void set(String file, String project, boolean on) {
        Map<String, Boolean> states = read(file);
        states.put(project, on);
        StringBuilder content = new StringBuilder();
        states.forEach((name, value) -> content.append(name).append('=').append(value ? "on" : "off").append('\n'));
        Path path = Path.of(file);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, content.toString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            log.error("Failed to write {}: {}", file, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }

    private static Map<String, Boolean> read(String file) {
        Path path = Path.of(file);
        Map<String, Boolean> states = new LinkedHashMap<>();
        if (!Files.isRegularFile(path)) {
            return states;
        }
        List<String> lines;
        try {
            lines = Files.readAllLines(path);
        } catch (IOException e) {
            log.warn("Could not read {}, treating every project as off: {}", file, e.getMessage());
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
