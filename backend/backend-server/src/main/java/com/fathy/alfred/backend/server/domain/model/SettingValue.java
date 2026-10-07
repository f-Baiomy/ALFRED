package com.fathy.alfred.backend.server.domain.model;

/**
 * What the Server section and {@code alfred config list} show for one setting. For a SECRET the value is never
 * carried: {@code value} is null and {@code isSet} says whether one exists.
 */
public record SettingValue(SettingDefinition definition, String value, boolean isSet, Source source,
                           String defaultValue, boolean differsFromDefault, PendingRestart pending) {
}
