package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * What the Server card's update row and {@code alfred update} show: the running version, the newest release the
 * feed names, whether that is an update for this machine, when the feed was last read, and the install in progress
 * if any. {@code error} is the last check's failure (the feed unreachable, a bad manifest) - the card shows it
 * instead of pretending the server is up to date. {@code releases}: every release newer than this one the feed lists,
 * newest first - more than one means the newest skips the others (each installer brings everything up to it).
 */
public record UpdateStatus(UpdateMode mode, RuntimeMode runtimeMode, String target, String currentVersion,
                           String latestVersion, boolean available, Instant checkedAt, String feedUrl, String notes,
                           String publishedAt, String installerUrl, long sizeBytes, String window, boolean canInstall,
                           UpdateJob job, String error, List<Release> releases) {

    /** One release this machine could install. */
    public record Release(String version, String publishedAt, String notes, long sizeBytes) {
    }

    public UpdateStatus(UpdateMode mode, RuntimeMode runtimeMode, String target, String currentVersion,
                        String latestVersion, boolean available, Instant checkedAt, String feedUrl, String notes,
                        String publishedAt, String installerUrl, long sizeBytes, String window, boolean canInstall,
                        UpdateJob job, String error) {
        this(mode, runtimeMode, target, currentVersion, latestVersion, available, checkedAt, feedUrl, notes, publishedAt,
                installerUrl, sizeBytes, window, canInstall, job, error, List.of());
    }
}
