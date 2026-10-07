package com.fathy.alfred.backend.server.adapter.out.envfile;

import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Defaults from settings.properties: each {@code some_key=${ENV_NAME:default}} line gives ENV_NAME's default. The
 * file's own key (lower case) is start.py's name for it and is not needed here. Read once; the file is replaced only
 * by an upgrade, which restarts Alfred. Never written (FR-013).
 */
public class SettingsPropertiesDefaultsAdapter implements DefaultsPort {

    private static final Logger log = LoggerFactory.getLogger(SettingsPropertiesDefaultsAdapter.class);
    private static final Pattern PLACEHOLDER = Pattern.compile("^\\$\\{([A-Za-z_][A-Za-z0-9_]*)(?::(.*))?}$");

    private final Map<String, String> defaults;

    public SettingsPropertiesDefaultsAdapter(Path file) {
        this.defaults = Map.copyOf(load(file));
    }

    @Override
    public Map<String, String> defaults() {
        return defaults;
    }

    static Map<String, String> parse(String content) {
        Map<String, String> map = new LinkedHashMap<>();
        for (String raw : content.split("\r?\n")) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#") || !line.contains("=")) {
                continue;
            }
            String value = line.substring(line.indexOf('=') + 1).strip();
            Matcher placeholder = PLACEHOLDER.matcher(value);
            if (placeholder.matches()) {
                map.put(placeholder.group(1), placeholder.group(2) == null ? "" : placeholder.group(2));
            }
        }
        return map;
    }

    private static Map<String, String> load(Path file) {
        if (!Files.isRegularFile(file)) {
            log.warn("Defaults file {} not found - every setting without a .env line will be empty", file);
            return Map.of();
        }
        try {
            return parse(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException e) {
            log.error("Could not read defaults file {}", file, e);
            return Map.of();
        }
    }
}
