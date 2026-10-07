package com.fathy.alfred.backend.server.domain.model;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Format and consistency rules for setting values (data-model "Validation rules by kind", FR-030/031). Everything here
 * is decidable from the values alone; rules that need the machine (a port in use, a folder that does not exist, free
 * disk) are probes, run by the application service. ERROR blocks a save, WARNING never does.
 *
 * <p>Values are normalised before they are stored, so .env always holds one spelling: sizes in bytes (FR-017; the UI
 * and CLI may say "2 GB"), memory in lower case, booleans as true/false, lists in their canonical serialisation.
 */
public final class SettingsValidator {

    private static final Pattern SIZE = Pattern.compile("^(\\d+(?:\\.\\d+)?)\\s*(B|KB|MB|GB|TB)?$", Pattern.CASE_INSENSITIVE);
    private static final Pattern MEMORY = Pattern.compile("^(\\d+)([mg])$");
    private static final Pattern INTEGER = Pattern.compile("^\\d{1,12}$");
    private static final Pattern PROJECT_NAME = Pattern.compile("^[A-Za-z0-9_-]{1,40}$");
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.\\-]{1,253}$|^\\[[0-9A-Fa-f:.]+]$");
    private static final long MIN_MEMORY_MB = 512;

    private SettingsValidator() {
    }

    /** Thrown by {@link #normalize} for a value that cannot be stored at all. */
    public static final class InvalidValue extends RuntimeException {
        public InvalidValue(String message) {
            super(message);
        }
    }

    /** The one spelling of {@code raw} that is written to .env, or {@link InvalidValue}. */
    public static String normalize(SettingDefinition definition, String raw) {
        String value = raw == null ? "" : raw.strip();
        return switch (definition.kind()) {
            case BOOLEAN -> switch (value.toLowerCase(Locale.ROOT)) {
                case "true", "on", "yes", "1" -> "true";
                case "false", "off", "no", "0" -> "false";
                default -> throw new InvalidValue("use true or false");
            };
            case SIZE_BYTES -> String.valueOf(sizeInBytes(value));
            case MEMORY -> {
                Matcher m = MEMORY.matcher(value.toLowerCase(Locale.ROOT));
                if (!m.matches()) {
                    throw new InvalidValue("use e.g. 2g or 1536m");
                }
                yield m.group(1) + m.group(2);
            }
            case INTEGER, PORT -> {
                if (!INTEGER.matcher(value).matches()) {
                    throw new InvalidValue("not a whole number");
                }
                yield String.valueOf(Long.parseLong(value));
            }
            case ENUM -> {
                String lower = value.toLowerCase(Locale.ROOT);
                if (!definition.enumValues().contains(lower)) {
                    throw new InvalidValue("use " + String.join(", ", definition.enumValues()));
                }
                yield lower;
            }
            case PROJECT_LIST -> ServicesGrammar.serializeProjects(ServicesGrammar.parseProjects(value));
            case FOLDER_LIST -> ServicesGrammar.serializeFolders(ServicesGrammar.parseFolders(value, w -> { }));
            case ACCESS_LIST -> String.join(",", splitList(value));
            default -> value;
        };
    }

    /** "2 GB", "500MB", "2147483648" -> bytes (binary units, as the UI shows them). */
    public static long sizeInBytes(String value) {
        Matcher m = SIZE.matcher(value == null ? "" : value.strip());
        if (!m.matches()) {
            throw new InvalidValue("not a size - use e.g. 500 MB, 2 GB, or bytes");
        }
        BigDecimal number = new BigDecimal(m.group(1));
        String unit = m.group(2) == null ? "B" : m.group(2).toUpperCase(Locale.ROOT);
        long factor = switch (unit) {
            case "KB" -> 1024L;
            case "MB" -> 1024L * 1024;
            case "GB" -> 1024L * 1024 * 1024;
            case "TB" -> 1024L * 1024 * 1024 * 1024;
            default -> 1L;
        };
        return number.multiply(BigDecimal.valueOf(factor)).longValue();
    }

    /** "2g" -> megabytes. */
    public static long memoryInMegabytes(String value) {
        Matcher m = MEMORY.matcher(value == null ? "" : value.strip().toLowerCase(Locale.ROOT));
        if (!m.matches()) {
            throw new InvalidValue("use e.g. 2g or 1536m");
        }
        long n = Long.parseLong(m.group(1));
        return m.group(2).equals("g") ? n * 1024 : n;
    }

    /**
     * Rules for the edited keys, judged against the settings as they would be after the save ({@code effective}),
     * plus the cross-field rules that an edit to one setting can break in another.
     */
    public static List<ValidationResult> validate(Map<String, String> effective, Set<String> editedKeys) {
        List<ValidationResult> results = new ArrayList<>();
        for (String key : editedKeys) {
            SettingDefinition definition = SettingCatalog.find(key).orElse(null);
            if (definition == null) {
                results.add(ValidationResult.error(key, "not a setting"));
                continue;
            }
            results.addAll(validateOne(definition, effective.getOrDefault(key, "")));
        }
        if (editedKeys.contains("INTERNAL_CALL_SERVICES") || editedKeys.contains("ALFRED_UI_PORT")) {
            results.addAll(projectsAgainstPorts(effective));
        }
        return results;
    }

    static List<ValidationResult> validateOne(SettingDefinition d, String value) {
        String key = d.key();
        List<ValidationResult> out = new ArrayList<>();
        try {
            switch (d.kind()) {
                case BOOLEAN, ENUM, MEMORY -> normalize(d, value);
                case INTEGER -> range(d, Long.parseLong(normalize(d, value)), out);
                case SIZE_BYTES -> range(d, sizeInBytes(value), out);
                case PORT -> port(key, normalize(d, value), out);
                case HOST_PORT -> hostPort(key, value, out);
                case PATH -> path(d, value, out);
                case PROJECT_LIST -> projects(key, value, out);
                case FOLDER_LIST -> folders(key, value, out);
                case ACCESS_LIST -> access(key, value, out);
                case SECRET -> {
                    if (value.contains(" ") || value.contains("\"")) {
                        out.add(ValidationResult.error(key, "no spaces or quotes"));
                    }
                }
                case URL -> url(key, value, out);
                case TIME_WINDOW -> timeWindow(key, value, out);
            }
            if (d.kind() == SettingKind.MEMORY && memoryInMegabytes(value) < MIN_MEMORY_MB) {
                out.add(ValidationResult.error(key, "at least 512m"));
            }
        } catch (InvalidValue | NumberFormatException e) {
            out.add(ValidationResult.error(key, e instanceof InvalidValue ? e.getMessage() : "not a number"));
        }
        return out;
    }

    private static void url(String key, String value, List<ValidationResult> out) {
        String text = value == null ? "" : value.strip();
        if (text.isEmpty()) {
            out.add(ValidationResult.error(key, "empty - use the GitHub feed or a file URL"));
            return;
        }
        try {
            java.net.URI uri = java.net.URI.create(text);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("file")) {
                out.add(ValidationResult.error(key, "use an https://, http:// or file:// URL"));
            } else if (!scheme.equals("file") && (uri.getHost() == null || uri.getHost().isEmpty())) {
                out.add(ValidationResult.error(key, "the URL names no host"));
            }
        } catch (IllegalArgumentException e) {
            out.add(ValidationResult.error(key, "not a URL"));
        }
    }

    private static final Pattern TIME_WINDOW = Pattern.compile("^([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$");

    private static void timeWindow(String key, String value, List<ValidationResult> out) {
        String text = value == null ? "" : value.strip();
        if (!text.isEmpty() && !TIME_WINDOW.matcher(text).matches()) {
            out.add(ValidationResult.error(key, "use HH:MM-HH:MM, e.g. 02:00-04:00, or leave it empty"));
        }
    }

    private static void range(SettingDefinition d, long value, List<ValidationResult> out) {
        if (d.min() != null && value < d.min()) {
            out.add(ValidationResult.error(d.key(), "at least " + human(d, d.min())));
        }
        if (d.max() != null && value > d.max()) {
            out.add(ValidationResult.error(d.key(), "at most " + human(d, d.max())));
        }
    }

    private static String human(SettingDefinition d, long n) {
        return d.kind() == SettingKind.SIZE_BYTES ? (n / (1024 * 1024)) + " MB" : String.valueOf(n);
    }

    private static void port(String key, String value, List<ValidationResult> out) {
        long port = Long.parseLong(value);
        if (port < 1 || port > 65535) {
            out.add(ValidationResult.error(key, "a port is 1-65535"));
        }
    }

    private static void hostPort(String key, String value, List<ValidationResult> out) {
        int colon = value.lastIndexOf(':');
        if (colon <= 0 || !HOST.matcher(value.substring(0, colon)).matches()
                || !INTEGER.matcher(value.substring(colon + 1)).matches()) {
            out.add(ValidationResult.error(key, "use host:port, e.g. 127.0.0.2:443"));
            return;
        }
        port(key, value.substring(colon + 1), out);
    }

    private static void path(SettingDefinition d, String value, List<ValidationResult> out) {
        if (value.isEmpty()) {
            if (!"WILDFLY_HOME".equals(d.key())) {
                out.add(ValidationResult.error(d.key(), "a folder is needed"));
            }
            return;
        }
        if (!DockerEnvImport.isAbsolute(value) && !value.startsWith("./") && !value.startsWith(".\\")) {
            out.add(ValidationResult.error(d.key(), "use a full path, e.g. /opt/app/logs (or ./name inside the Alfred folder)"));
        }
    }

    private static void projects(String key, String value, List<ValidationResult> out) {
        Set<String> names = new HashSet<>();
        Set<Integer> listenPorts = new HashSet<>();
        Set<String> outbound = new HashSet<>();
        for (String raw : splitList(value)) {
            List<Project> parsed = ServicesGrammar.parseProjects(raw);
            if (parsed.isEmpty()) {
                out.add(ValidationResult.error(key, "'" + raw + "' is not name:listenPort:appPort[:outboundHost[:outboundPort]]"));
                continue;
            }
            Project p = parsed.get(0);
            if (!PROJECT_NAME.matcher(p.name()).matches()) {
                out.add(ValidationResult.error(key, "project name '" + p.name() + "': letters, digits, - and _ (max 40)"));
            }
            if (!names.add(p.name())) {
                out.add(ValidationResult.error(key, "project name '" + p.name() + "' is used twice"));
            }
            if (!listenPorts.add(p.listenPort())) {
                out.add(ValidationResult.error(key, "listen port " + p.listenPort() + " is used by two projects"));
            }
            if (p.listenPort() == p.upstreamPort()) {
                out.add(ValidationResult.error(key, p.name() + ": the listen port must differ from the app's own port"));
            }
            for (int port : new int[]{p.listenPort(), p.upstreamPort()}) {
                if (port < 1 || port > 65535) {
                    out.add(ValidationResult.error(key, p.name() + ": a port is 1-65535"));
                }
            }
            if (p.outboundHost() != null && !outbound.add(p.outboundHost() + ":" + p.outboundPort())) {
                out.add(ValidationResult.error(key, "outbound address " + p.outboundHost() + ":" + p.outboundPort() + " is used by two projects"));
            }
        }
    }

    private static void folders(String key, String value, List<ValidationResult> out) {
        Set<String> names = new HashSet<>();
        Set<String> paths = new HashSet<>();
        for (String raw : splitList(value)) {
            List<WatchedFolder> parsed = ServicesGrammar.parseFolders(raw, w -> { });
            if (parsed.isEmpty()) {
                out.add(ValidationResult.error(key, "'" + raw + "' is not name:path (name: letters, digits, - and _)"));
                continue;
            }
            WatchedFolder f = parsed.get(0);
            if (!names.add(f.name())) {
                out.add(ValidationResult.error(key, "folder name '" + f.name() + "' is used twice"));
            }
            if (!paths.add(f.path())) {
                out.add(ValidationResult.error(key, f.path() + " is already in the list"));
            }
            if (!DockerEnvImport.isAbsolute(f.path())) {
                out.add(ValidationResult.error(key, f.name() + ": use a full path"));
            }
        }
    }

    private static void access(String key, String value, List<ValidationResult> out) {
        List<String> tokens = splitList(value);
        for (String token : tokens) {
            if (!AccessRule.validToken(token)) {
                out.add(ValidationResult.error(key, "'" + token + "' is not local, lan, an address or a range like 192.168.1.0/24"));
            }
        }
        if (!tokens.contains("local")) {
            out.add(ValidationResult.warning(key, "without 'local' this machine itself cannot change settings from the UI (alfred config still can)"));
        }
    }

    /** A project's listen port must not be the UI port either. */
    private static List<ValidationResult> projectsAgainstPorts(Map<String, String> effective) {
        List<ValidationResult> out = new ArrayList<>();
        String ui = effective.getOrDefault("ALFRED_UI_PORT", "");
        Map<Integer, String> taken = new HashMap<>();
        if (INTEGER.matcher(ui).matches()) {
            taken.put(Integer.parseInt(ui), "the web UI");
        }
        for (Project p : ServicesGrammar.parseProjects(effective.getOrDefault("INTERNAL_CALL_SERVICES", ""))) {
            String owner = taken.get(p.listenPort());
            if (owner != null) {
                out.add(ValidationResult.error("INTERNAL_CALL_SERVICES", p.name() + ": port " + p.listenPort() + " is " + owner + "'s"));
            }
        }
        return out;
    }

    static List<String> splitList(String value) {
        List<String> out = new ArrayList<>();
        for (String part : (value == null ? "" : value).split(",")) {
            if (!part.isBlank()) {
                out.add(part.strip());
            }
        }
        return out;
    }
}
