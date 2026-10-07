package com.fathy.alfred.backend.server.domain.model;

import java.time.Instant;

/**
 * What the Server card's update row and {@code alfred update} show: the running version, the newest release the
 * feed names, whether that is an update for this machine, when the feed was last read, and the install in progress
 * if any. {@code error} is the last check's failure (the feed unreachable, a bad manifest) - the card shows it
 * instead of pretending the server is up to date.
 */
public record UpdateStatus(UpdateMode mode, RuntimeMode runtimeMode, String target, String currentVersion,
                           String latestVersion, boolean available, Instant checkedAt, String feedUrl, String notes,
                           String publishedAt, String installerUrl, long sizeBytes, String window, boolean canInstall,
                           UpdateJob job, String error) {
}
