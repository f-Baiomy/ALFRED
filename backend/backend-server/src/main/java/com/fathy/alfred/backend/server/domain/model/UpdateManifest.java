package com.fathy.alfred.backend.server.domain.model;

import java.util.Map;
import java.util.Optional;

/**
 * What a release publishes next to its installers as {@code latest.json} (written by build_dist.py): the version,
 * its notes, and one installer per target with the checksum the supervisor verifies before running it.
 */
public record UpdateManifest(String version, String notes, String publishedAt, Map<String, Asset> assets) {

    public record Asset(String url, String sha256, long size) {
    }

    public Optional<Asset> asset(String target) {
        return Optional.ofNullable(assets == null ? null : assets.get(target));
    }
}
