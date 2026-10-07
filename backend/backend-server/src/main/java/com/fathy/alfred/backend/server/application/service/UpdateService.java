package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.UpdateUseCase;
import com.fathy.alfred.backend.server.application.port.out.RuntimeInfoPort;
import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.application.port.out.UpdateFeedPort;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;
import com.fathy.alfred.backend.server.domain.model.UpdateManifest;
import com.fathy.alfred.backend.server.domain.model.UpdateMode;
import com.fathy.alfred.backend.server.domain.model.UpdateStatus;
import com.fathy.alfred.backend.server.domain.model.VersionOrder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Check for updates, install one (US "check for updates and auto-update").
 *
 * The check is one small read of the feed's {@code latest.json}: at start, once a day, and whenever a user asks.
 * It never downloads an installer. Installing is the supervisor's job (it outlives the backend the installer
 * stops) - this service only asks for it, and only for the release the last check found, with that release's
 * checksum. AUTO mode asks by itself, inside the window, so a server is never restarted in the middle of the day.
 *
 * The settings are read on every pass rather than injected: all three are LIVE, and a change made in the Settings
 * tab must count at the next tick without a restart.
 */
public class UpdateService implements UpdateUseCase {

    private static final Logger log = LoggerFactory.getLogger(UpdateService.class);
    static final Duration CHECK_EVERY = Duration.ofHours(24);

    private final UpdateFeedPort feed;
    private final SupervisorPort supervisor;
    private final RuntimeInfoPort runtime;
    private final Supplier<Map<String, String>> settings;
    private final ServerEventsPort events;
    private final RuntimeMode mode;
    private final Clock clock;
    private final String target;

    private volatile UpdateManifest latest;
    private volatile Instant checkedAt;
    private volatile String error = "";
    private volatile Instant autoInstallAskedAt;

    public UpdateService(UpdateFeedPort feed, SupervisorPort supervisor, RuntimeInfoPort runtime,
                         Supplier<Map<String, String>> settings, ServerEventsPort events, RuntimeMode mode, Clock clock,
                         String target) {
        this.feed = feed;
        this.supervisor = supervisor;
        this.runtime = runtime;
        this.settings = settings;
        this.events = events;
        this.mode = mode;
        this.clock = clock;
        this.target = target;
    }

    @Override
    public UpdateStatus status() {
        Map<String, String> now = settings.get();
        UpdateMode updateMode = UpdateMode.of(now.get("ALFRED_UPDATE_MODE"));
        UpdateManifest manifest = latest;
        String current = runtime.version();
        Optional<UpdateManifest.Asset> asset = manifest == null ? Optional.empty() : manifest.asset(target);
        boolean available = manifest != null && asset.isPresent() && VersionOrder.isNewer(manifest.version(), current);
        UpdateJob job = mode == RuntimeMode.NATIVE ? supervisor.updateJob().orElse(UpdateJob.idle()) : UpdateJob.idle();
        boolean canInstall = available && mode == RuntimeMode.NATIVE && supervisor.available()
                && job.state() != UpdateJob.State.DOWNLOADING && job.state() != UpdateJob.State.VERIFYING
                && job.state() != UpdateJob.State.INSTALLING;
        return new UpdateStatus(updateMode, mode, target, current,
                manifest == null ? "" : manifest.version(), available, checkedAt, feedUrl(now),
                manifest == null ? "" : nullToEmpty(manifest.notes()), manifest == null ? "" : nullToEmpty(manifest.publishedAt()),
                asset.map(UpdateManifest.Asset::url).orElse(""), asset.map(UpdateManifest.Asset::size).orElse(0L),
                now.getOrDefault("ALFRED_UPDATE_WINDOW", ""), canInstall, job, error);
    }

    @Override
    public UpdateStatus check() {
        Map<String, String> now = settings.get();
        if (UpdateMode.of(now.get("ALFRED_UPDATE_MODE")) == UpdateMode.OFF) {
            error = "";
            checkedAt = clock.instant();
            return status();
        }
        String url = feedUrl(now);
        try {
            UpdateManifest manifest = feed.fetch(url);
            if (manifest.version() == null || manifest.version().isBlank()) {
                throw new IOException("the manifest names no version");
            }
            latest = manifest;
            error = "";
            log.info("Update check: running {}, newest release {}{}", runtime.version(), manifest.version(),
                    VersionOrder.isNewer(manifest.version(), runtime.version()) ? " (update available)" : "");
        } catch (IOException | RuntimeException e) {
            error = "Could not read " + url + ": " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            log.warn("Update check failed: {}", error);
        }
        checkedAt = clock.instant();
        events.serverChanged("update");
        return status();
    }

    @Override
    public void install() {
        if (mode != RuntimeMode.NATIVE) {
            throw new IllegalStateException("Alfred runs with Docker here: update it with python3 deploy.py");
        }
        UpdateStatus status = status();
        if (!status.available()) {
            throw new IllegalStateException(status.latestVersion().isEmpty()
                    ? "No update check has succeeded yet" : "Alfred " + status.currentVersion() + " is up to date");
        }
        if (!supervisor.available()) {
            throw new IllegalStateException("No supervisor is running - start Alfred with 'alfred start' to update it from here");
        }
        UpdateManifest.Asset asset = latest.asset(target).orElseThrow();
        if (asset.sha256() == null || asset.sha256().isBlank()) {
            throw new IllegalStateException("The release carries no checksum for " + target + " - not installing it");
        }
        if (!supervisor.installUpdate(latest.version(), asset.url(), asset.sha256(), asset.size())) {
            throw new IllegalStateException("The supervisor did not accept the update (is one already in progress?)");
        }
        events.serverChanged("update");
    }

    @Override
    public void tick() {
        Map<String, String> now = settings.get();
        UpdateMode updateMode = UpdateMode.of(now.get("ALFRED_UPDATE_MODE"));
        if (updateMode == UpdateMode.OFF) {
            return;
        }
        Instant at = clock.instant();
        if (checkedAt == null || Duration.between(checkedAt, at).compareTo(CHECK_EVERY) >= 0) {
            check();
        }
        if (updateMode != UpdateMode.AUTO || mode != RuntimeMode.NATIVE) {
            return;
        }
        UpdateStatus status = status();
        if (!status.canInstall() || !inWindow(now.getOrDefault("ALFRED_UPDATE_WINDOW", ""), LocalTime.now(clock))) {
            return;
        }
        // One ask per release: the supervisor restarts Alfred, and until it does the status still says "available".
        if (autoInstallAskedAt != null && Duration.between(autoInstallAskedAt, at).compareTo(Duration.ofHours(6)) < 0) {
            return;
        }
        autoInstallAskedAt = at;
        log.info("Auto-update: installing Alfred {} (window {})", status.latestVersion(), status.window());
        try {
            install();
        } catch (IllegalStateException e) {
            log.warn("Auto-update not started: {}", e.getMessage());
        }
    }

    /** "02:00-04:00" (may wrap midnight: "23:00-01:00"); blank means any time. */
    static boolean inWindow(String window, LocalTime now) {
        if (window == null || window.isBlank()) {
            return true;
        }
        String[] parts = window.strip().split("-");
        if (parts.length != 2) {
            return false;
        }
        try {
            LocalTime from = LocalTime.parse(parts[0].strip());
            LocalTime to = LocalTime.parse(parts[1].strip());
            if (from.equals(to)) {
                return true;
            }
            return from.isBefore(to) ? !now.isBefore(from) && now.isBefore(to) : !now.isBefore(from) || now.isBefore(to);
        } catch (java.time.format.DateTimeParseException e) {
            return false;
        }
    }

    private static String feedUrl(Map<String, String> now) {
        return now.getOrDefault("ALFRED_UPDATE_URL", "").strip();
    }

    private static String nullToEmpty(String text) {
        return text == null ? "" : text;
    }

    static ZoneId zone(Clock clock) {
        return clock.getZone();
    }
}
