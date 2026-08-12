package com.fathy.alfred.backend.settings.domain.model;

/**
 * One whitelist or blacklist entry - {@code host} is always a normalized hostname (see
 * HostNormalizer), never a raw URL, so matching is a plain equals() regardless of what scheme/
 * path/query/port the user originally typed. {@code enabled} lets a whitelist entry be switched
 * off temporarily without losing/re-typing it - blacklist entries are always enabled (the
 * frontend never renders a toggle for them, only add/remove), but the field is shared across both
 * lists rather than having two near-identical record types.
 */
public record UrlRule(String id, String host, boolean enabled) {
}
