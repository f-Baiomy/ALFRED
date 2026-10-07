package com.fathy.alfred.backend.server.application.port.in;

import java.util.List;

/**
 * Moving settings between servers (FR-027/028): download this .env with its secrets hidden, and read an uploaded one
 * into values the editor can place in the form. Neither writes anything.
 */
public interface ImportEnvUseCase {

    String SECRET_PLACEHOLDER = "<set on server>";

    /** One uploaded value, checked as the editor would check it. {@code current} is the value in effect now. */
    record ImportedValue(String key, String value, String current, boolean valid, String message) {
    }

    /** {@code unknown}: keys that are not settings; {@code secrets}: secret keys, never imported. */
    record Imported(List<ImportedValue> values, List<String> unknown, List<String> secrets) {
    }

    /** .env as it is on disk, each secret's value replaced by {@link #SECRET_PLACEHOLDER}. */
    String maskedEnvFile();

    Imported read(String envText);
}
