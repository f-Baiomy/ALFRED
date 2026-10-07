package com.fathy.alfred.backend.server.domain.model;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * The Java port of the two list grammars in alfred_settings.py (parse_service_entries, parse_watch_dirs). Both run the
 * same vectors (specs/012-server-program/fixtures/services-grammar.json) so the supervisor, start.py and the backend
 * can never read the same .env line differently.
 *
 * <p>Parsing is lenient on purpose, exactly like the Python: a malformed entry is dropped, not fatal, because start.py
 * has always tolerated them. Strictness belongs to {@code SettingsValidator}, which reports every dropped entry as an
 * ERROR before a save so the UI and CLI never write one.
 */
public final class ServicesGrammar {

    /** Same rule as alfred_settings.WATCH_DIR_NAME. */
    public static final Pattern FOLDER_NAME = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$");
    private static final Pattern DIGITS = Pattern.compile("^[0-9]+$");
    private static final int DEFAULT_OUTBOUND_PORT = 443;

    private ServicesGrammar() {
    }

    /** "name:listen:upstream[:outboundHost[:outboundPort]],..." - duplicate listen ports keep the first entry. */
    public static List<Project> parseProjects(String value) {
        List<Project> projects = new ArrayList<>();
        Set<String> seenListenPorts = new HashSet<>();
        for (String raw : (value == null ? "" : value).split(",", -1)) {
            String entry = raw.strip();
            if (entry.isEmpty()) {
                continue;
            }
            String[] parts = entry.split(":", -1);
            for (int i = 0; i < parts.length; i++) {
                parts[i] = parts[i].strip();
            }
            if (parts.length < 3 || parts.length > 5) {
                continue;
            }
            String name = parts[0];
            String listen = parts[1];
            String upstream = parts[2];
            if (name.isEmpty() || !DIGITS.matcher(listen).matches() || !DIGITS.matcher(upstream).matches()) {
                continue;
            }
            if (!seenListenPorts.add(listen)) {
                continue;
            }
            String outboundHost = parts.length >= 4 && !parts[3].isEmpty() ? parts[3] : null;
            Integer outboundPort = null;
            if (outboundHost != null) {
                String port = parts.length == 5 && !parts[4].isEmpty() ? parts[4] : String.valueOf(DEFAULT_OUTBOUND_PORT);
                if (DIGITS.matcher(port).matches()) {
                    outboundPort = Integer.parseInt(port);
                } else {
                    // A typo in the 5th field drops only the outbound part, not the project's inbound logging.
                    outboundHost = null;
                }
            }
            projects.add(new Project(name, Integer.parseInt(listen), Integer.parseInt(upstream), outboundHost, outboundPort));
        }
        return projects;
    }

    /** "name:path,..." split on the FIRST colon, so Windows paths (C:\logs) survive. */
    public static List<WatchedFolder> parseFolders(String value, Consumer<String> warn) {
        List<WatchedFolder> folders = new ArrayList<>();
        for (String raw : (value == null ? "" : value).split(",", -1)) {
            String entry = raw.strip();
            int colon = entry.indexOf(':');
            if (colon < 0) {
                continue;
            }
            String name = entry.substring(0, colon).strip();
            String path = entry.substring(colon + 1).strip();
            if (!FOLDER_NAME.matcher(name).matches()) {
                warn.accept("logs_watch_dirs: skipping '" + entry + "' - a name is letters, digits, '-' or '_' (max 40)");
                continue;
            }
            if (path.isEmpty()) {
                continue;
            }
            folders.add(new WatchedFolder(name, path));
        }
        return folders;
    }

    public static String serializeProjects(List<Project> projects) {
        return String.join(",", projects.stream().map(Project::serialize).toList());
    }

    public static String serializeFolders(List<WatchedFolder> folders) {
        return String.join(",", folders.stream().map(WatchedFolder::serialize).toList());
    }
}
