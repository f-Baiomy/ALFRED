package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonCreator;

import java.util.Locale;

/**
 * How Alfred's agent gets into a project's application on a native install (docs/server.md "The agent attaches
 * itself"). {@code WHEN_ASKED}, the default: at Alfred's start, when a call arrives for the project and no agent
 * reports, and on "Attach now". {@code AUTOMATIC}: all of that, and the moment the app's upstream port opens or its
 * pid changes - the supervisor watches the port, so the agent is in place seconds after the app starts, before its
 * first call. {@code OFF}: never by itself ({@code alfred attach} still works).
 */
public enum AttachMode {
    OFF, WHEN_ASKED, AUTOMATIC;

    public static final AttachMode DEFAULT = WHEN_ASKED;

    /** Lenient: the UI's spelling, the old boolean switch ("true"/"false"), anything else -> the default. */
    @JsonCreator
    public static AttachMode of(String text) {
        if (text == null) {
            return DEFAULT;
        }
        return switch (text.strip().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_')) {
            case "OFF", "FALSE", "NEVER" -> OFF;
            case "AUTOMATIC", "AUTO", "WATCH" -> AUTOMATIC;
            default -> WHEN_ASKED;
        };
    }
}
