package com.fathy.alfred.backend.settings.domain.model;

import java.util.List;

/** The whole call-filtering configuration - one global instance, not per-user/per-cycle. */
public record CallFilterSettings(FilterMode mode, List<UrlRule> whitelist, List<UrlRule> blacklist) {

    public static CallFilterSettings defaults() {
        return new CallFilterSettings(FilterMode.ACCEPT_ALL, List.of(), List.of());
    }
}
