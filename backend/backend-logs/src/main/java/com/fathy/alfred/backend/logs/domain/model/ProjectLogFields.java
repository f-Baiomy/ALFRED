package com.fathy.alfred.backend.logs.domain.model;

import java.util.Comparator;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Finds a project's thread and call-id fields in a log source's structure (specs/008-logs-call-link). A setting may name
 * a field by its label ("name") or its JSON path ("process.thread.name"), and the call id may sit under the MDC or at
 * the top level depending on the log formatter: WildFly's JSON formatter writes {@code "alfred.call"} at the top level
 * (label "call"), others nest it as {@code mdc.alfred.call}. Unset or unmatched, both are found by their path.
 */
public final class ProjectLogFields {

    /** The key the db-agent puts in the MDC. */
    public static final String CALL_KEY = "alfred.call";
    private static final Pattern THREAD_PATH = Pattern.compile("(?i)(^|[._])thread([._]?name)?$");

    private ProjectLogFields() {
    }

    /** A stored field by label, then by exact path, then by a path that is the tail of the given name or vice versa. */
    public static Optional<FieldDef> resolve(LogStructure structure, String name) {
        if (name == null || name.isBlank()) {
            return Optional.empty();
        }
        Optional<FieldDef> byLabel = structure.fields().stream().filter(FieldDef::stored).filter(f -> f.label().equals(name)).findFirst();
        if (byLabel.isPresent()) {
            return byLabel;
        }
        Optional<FieldDef> byPath = structure.fields().stream().filter(FieldDef::stored).filter(f -> name.equals(f.path())).findFirst();
        if (byPath.isPresent()) {
            return byPath;
        }
        return structure.fields().stream().filter(FieldDef::stored).filter(f -> f.path() != null)
                .filter(f -> name.endsWith("." + f.path()) || f.path().endsWith("." + name))
                .min(Comparator.comparingInt(f -> f.path().length()));
    }

    /** The call-id field: the configured one, else whichever field holds {@code alfred.call}. */
    public static Optional<FieldDef> callId(LogStructure structure, String configured) {
        return resolve(structure, configured).or(() -> resolve(structure, CALL_KEY));
    }

    /** The thread field: the configured one, else a field whose path is a thread name (thread, threadName, process.thread.name). */
    public static Optional<FieldDef> thread(LogStructure structure, String configured) {
        if (configured != null && !configured.isBlank()) {
            return resolve(structure, configured);
        }
        return structure.fields().stream().filter(FieldDef::stored)
                .filter(f -> THREAD_PATH.matcher(f.path() == null ? f.label() : f.path()).find())
                .min(Comparator.comparingInt((FieldDef f) -> f.path() == null ? 0 : f.path().toLowerCase(Locale.ROOT).contains("name") ? 0 : 1)
                        .thenComparingInt(FieldDef::index));
    }
}
