package com.fathy.alfred.backend.interception.domain.model;

import java.util.Locale;
import java.util.Set;

/**
 * Header and cookie names whose VALUE must never reach an interception record, a rule's
 * plain-language description, or a stored answer the user chose not to keep secrets in.
 *
 * <p>This is the single owner of the list. It is published to both proxies in the rules snapshot
 * ({@code sensitiveHeaders}, see FileRulesPublisherAdapter) and served to the frontend by
 * {@code GET /interception/sensitive-headers}, so neither keeps a copy that could drift.
 * {@code proxy/interception.py}'s built-in SENSITIVE_HEADERS is only the fallback for a snapshot
 * written by an older backend.
 */
public final class SensitiveHeaders {

    public static final Set<String> NAMES = Set.of(
            "authorization", "proxy-authorization", "cookie", "set-cookie",
            "x-api-key", "api-key", "x-auth-token", "authentication");

    private SensitiveHeaders() {
    }

    public static boolean isSensitive(String name) {
        return name != null && NAMES.contains(name.strip().toLowerCase(Locale.ROOT));
    }
}
