package com.fathy.alfred.backend.server.domain.model;

import java.util.List;

/**
 * One deploy-time setting of the catalog. The default is deliberately NOT here: it is read from settings.properties
 * (DefaultsPort), the one place defaults live, so the catalog never repeats a value that could drift.
 *
 * @param min lower bound for INTEGER/SIZE_BYTES (null = none)
 * @param max upper bound for INTEGER/SIZE_BYTES (null = none)
 */
public record SettingDefinition(String key, SettingGroup group, String label, String help, SettingKind kind,
                                ApplyMode applies, List<String> enumValues, Long min, Long max) {

    public SettingDefinition {
        enumValues = enumValues == null ? List.of() : List.copyOf(enumValues);
    }

    public boolean secret() {
        return kind == SettingKind.SECRET;
    }

    /** Lists are kept as one comma-separated line in .env (FR-018). */
    public boolean list() {
        return kind == SettingKind.PROJECT_LIST || kind == SettingKind.FOLDER_LIST || kind == SettingKind.ACCESS_LIST;
    }
}
