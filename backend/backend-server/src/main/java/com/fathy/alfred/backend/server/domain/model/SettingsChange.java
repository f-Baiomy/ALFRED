package com.fathy.alfred.backend.server.domain.model;

import java.util.List;

/**
 * One save request: the edits, and the hash of the .env the editor loaded (FR-036 - a save is refused when the file
 * changed in between).
 */
public record SettingsChange(String baseHash, List<Edit> edits) {

    /** {@code reset} removes the key's line, so its default applies again; {@code value} is then ignored. */
    public record Edit(String key, String value, boolean reset) {

        public static Edit set(String key, String value) {
            return new Edit(key, value, false);
        }

        public static Edit reset(String key) {
            return new Edit(key, null, true);
        }
    }

    public SettingsChange {
        edits = List.copyOf(edits);
    }
}
