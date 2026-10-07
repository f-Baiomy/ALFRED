package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.out.RuntimeInfoPort;
import com.fathy.alfred.backend.server.application.port.out.UpdateFeedPort;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;
import com.fathy.alfred.backend.server.domain.model.UpdateManifest;
import com.fathy.alfred.backend.server.domain.model.UpdateMode;
import com.fathy.alfred.backend.server.domain.model.UpdateStatus;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class UpdateServiceTest {

    static final UpdateManifest RELEASE_150 = new UpdateManifest("1.5.0", "Faster exports", "2026-10-08T10:00:00Z", Map.of(
            "linux-x64", new UpdateManifest.Asset("https://dl/alfred-1.5.0-linux-x64.run", "abc", 241),
            "windows-x64", new UpdateManifest.Asset("https://dl/alfred-1.5.0-windows-x64.exe", "def", 145)));

    final Map<String, String> settings = new HashMap<>(Map.of("ALFRED_UPDATE_MODE", "check",
            "ALFRED_UPDATE_URL", "https://feed/latest.json", "ALFRED_UPDATE_WINDOW", "02:00-04:00"));
    final Fakes.Supervisor supervisor = new Fakes.Supervisor();
    final List<String> events = new ArrayList<>();
    UpdateManifest feedAnswer = RELEASE_150;
    IOException feedFailure;
    int fetches;
    Instant now = Instant.parse("2026-10-08T12:00:00Z");
    String runningVersion = "1.4.0";

    private UpdateService service(RuntimeMode mode) {
        UpdateFeedPort feed = url -> {
            fetches++;
            if (feedFailure != null) {
                throw feedFailure;
            }
            return feedAnswer;
        };
        RuntimeInfoPort runtime = new RuntimeInfoPort() {
            public String version() { return runningVersion; }
            public String installDir() { return "/opt/alfred"; }
            public Instant startedAt() { return now; }
            public long pid() { return 1; }
            public long heapUsedBytes() { return 0; }
            public long heapMaxBytes() { return 0; }
        };
        Clock clock = new Clock() {
            public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            public Clock withZone(java.time.ZoneId zone) { return this; }
            public Instant instant() { return now; }
        };
        return new UpdateService(feed, supervisor, runtime, () -> settings, events::add, mode, clock, "linux-x64");
    }

    @Test
    void aCheckFindsTheReleaseAndSaysWhetherItIsAnUpdateForThisMachine() {
        UpdateStatus status = service(RuntimeMode.NATIVE).check();
        assertThat(status.available()).isTrue();
        assertThat(status.latestVersion()).isEqualTo("1.5.0");
        assertThat(status.currentVersion()).isEqualTo("1.4.0");
        assertThat(status.installerUrl()).endsWith("linux-x64.run");
        assertThat(status.sizeBytes()).isEqualTo(241);
        assertThat(status.notes()).isEqualTo("Faster exports");
        assertThat(status.checkedAt()).isEqualTo(now);
        assertThat(status.canInstall()).isTrue();
        assertThat(status.error()).isEmpty();
        assertThat(events).contains("update");
    }

    @Test
    void upToDateAndNoAssetForThisTargetAreNotUpdates() {
        runningVersion = "1.5.0";
        assertThat(service(RuntimeMode.NATIVE).check().available()).isFalse();
        runningVersion = "1.4.0";
        feedAnswer = new UpdateManifest("1.5.0", "", "", Map.of());
        assertThat(service(RuntimeMode.NATIVE).check().available()).isFalse();
    }

    @Test
    void aFailedCheckIsReportedNotHiddenAndKeepsTheLastGoodAnswer() {
        UpdateService service = service(RuntimeMode.NATIVE);
        service.check();
        feedFailure = new IOException("HTTP 503");
        UpdateStatus status = service.check();
        assertThat(status.error()).contains("https://feed/latest.json").contains("HTTP 503");
        assertThat(status.latestVersion()).isEqualTo("1.5.0");
        assertThat(status.available()).isTrue();
    }

    @Test
    void offMeansNoFeedIsEverRead() {
        settings.put("ALFRED_UPDATE_MODE", "off");
        UpdateService service = service(RuntimeMode.NATIVE);
        service.check();
        service.tick();
        assertThat(fetches).isZero();
        assertThat(service.status().mode()).isEqualTo(UpdateMode.OFF);
    }

    @Test
    void installAsksTheSupervisorForExactlyTheReleaseTheCheckFound() {
        UpdateService service = service(RuntimeMode.NATIVE);
        service.check();
        service.install();
        assertThat(supervisor.updatesAsked).containsExactly("1.5.0 https://dl/alfred-1.5.0-linux-x64.run abc 241");
    }

    @Test
    void installIsRefusedWithoutAnUpdateInDockerModeAndWhenTheSupervisorSaysNo() {
        assertThatThrownBy(() -> service(RuntimeMode.DOCKER).install()).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("deploy.py");
        UpdateService service = service(RuntimeMode.NATIVE);
        assertThatThrownBy(service::install).isInstanceOf(IllegalStateException.class).hasMessageContaining("No update check");
        runningVersion = "1.5.0";
        service.check();
        assertThatThrownBy(service::install).isInstanceOf(IllegalStateException.class).hasMessageContaining("up to date");
        runningVersion = "1.4.0";
        service.check();
        supervisor.acceptUpdates = false;
        assertThatThrownBy(service::install).isInstanceOf(IllegalStateException.class).hasMessageContaining("did not accept");
        supervisor.acceptUpdates = true;
        supervisor.available = false;
        assertThatThrownBy(service::install).isInstanceOf(IllegalStateException.class).hasMessageContaining("alfred start");
    }

    @Test
    void aReleaseWithoutAChecksumIsNeverInstalled() {
        feedAnswer = new UpdateManifest("1.5.0", "", "", Map.of("linux-x64", new UpdateManifest.Asset("https://dl/x.run", "", 1)));
        UpdateService service = service(RuntimeMode.NATIVE);
        service.check();
        assertThatThrownBy(service::install).isInstanceOf(IllegalStateException.class).hasMessageContaining("checksum");
        assertThat(supervisor.updatesAsked).isEmpty();
    }

    @Test
    void theTickChecksOnceADayNotEveryHour() {
        UpdateService service = service(RuntimeMode.NATIVE);
        service.tick();
        service.tick();
        assertThat(fetches).isEqualTo(1);
        now = now.plus(Duration.ofHours(25));
        service.tick();
        assertThat(fetches).isEqualTo(2);
    }

    @Test
    void autoModeInstallsOnlyInsideTheWindowAndAsksOnce() {
        settings.put("ALFRED_UPDATE_MODE", "auto");
        UpdateService service = service(RuntimeMode.NATIVE);
        service.tick();                       // 12:00 - outside 02:00-04:00
        assertThat(supervisor.updatesAsked).isEmpty();
        now = Instant.parse("2026-10-09T03:00:00Z");
        service.tick();
        assertThat(supervisor.updatesAsked).hasSize(1);
        now = now.plus(Duration.ofMinutes(30));
        service.tick();                       // still in the window, same release: not asked again
        assertThat(supervisor.updatesAsked).hasSize(1);
    }

    @Test
    void autoModeNeverStartsASecondInstallWhileOneIsRunning() {
        settings.put("ALFRED_UPDATE_MODE", "auto");
        settings.put("ALFRED_UPDATE_WINDOW", "");
        supervisor.job = new UpdateJob(UpdateJob.State.DOWNLOADING, "1.5.0", 10, 241, "");
        UpdateService service = service(RuntimeMode.NATIVE);
        service.tick();
        assertThat(supervisor.updatesAsked).isEmpty();
        assertThat(service.status().canInstall()).isFalse();
    }

    @Test
    void windows() {
        assertThat(UpdateService.inWindow("", LocalTime.NOON)).isTrue();
        assertThat(UpdateService.inWindow("02:00-04:00", LocalTime.of(3, 0))).isTrue();
        assertThat(UpdateService.inWindow("02:00-04:00", LocalTime.of(4, 0))).isFalse();
        assertThat(UpdateService.inWindow("23:00-01:00", LocalTime.of(23, 30))).isTrue();
        assertThat(UpdateService.inWindow("23:00-01:00", LocalTime.of(0, 30))).isTrue();
        assertThat(UpdateService.inWindow("23:00-01:00", LocalTime.of(2, 0))).isFalse();
        assertThat(UpdateService.inWindow("garbage", LocalTime.NOON)).isFalse();
    }
}
