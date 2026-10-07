package com.fathy.alfred.backend.server.domain.model;

import java.util.Locale;

/** ALFRED_UPDATE_MODE: never look, look and tell (the default), or look and install inside ALFRED_UPDATE_WINDOW. */
public enum UpdateMode {
    OFF, CHECK, AUTO;

    public static UpdateMode of(String text) {
        if (text == null) {
            return CHECK;
        }
        return switch (text.strip().toLowerCase(Locale.ROOT)) {
            case "off" -> OFF;
            case "auto" -> AUTO;
            default -> CHECK;
        };
    }
}
