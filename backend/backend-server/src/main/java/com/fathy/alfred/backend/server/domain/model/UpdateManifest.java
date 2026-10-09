package com.fathy.alfred.backend.server.domain.model;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * What a release publishes next to its installers as {@code latest.json} (written by build_dist.py): the version,
 * its notes, and one installer per target with the checksum the supervisor verifies before running it.
 * {@code releases} are the recent releases before it, newest first, in the same shape - so a machine several releases
 * behind can see what it would skip, and install any of them; an older manifest has none.
 */
public record UpdateManifest(String version, String notes, String publishedAt, Map<String, Asset> assets,
                             List<UpdateManifest> releases) {

    public record Asset(String url, String sha256, long size) {
    }

    public UpdateManifest(String version, String notes, String publishedAt, Map<String, Asset> assets) {
        this(version, notes, publishedAt, assets, List.of());
    }

    public Optional<Asset> asset(String target) {
        return Optional.ofNullable(assets == null ? null : assets.get(target));
    }

    /** This release and the recent ones before it, newest first, one entry per version. */
    public List<UpdateManifest> all() {
        Map<String, UpdateManifest> byVersion = new LinkedHashMap<>();
        byVersion.put(version, this);
        for (UpdateManifest older : releases == null ? List.<UpdateManifest>of() : releases) {
            if (older != null && older.version() != null && !older.version().isBlank()) {
                byVersion.putIfAbsent(older.version(), older);
            }
        }
        List<UpdateManifest> list = new ArrayList<>(byVersion.values());
        list.sort((a, b) -> VersionOrder.isNewer(a.version(), b.version()) ? -1 : VersionOrder.isNewer(b.version(), a.version()) ? 1 : 0);
        return list;
    }
}
