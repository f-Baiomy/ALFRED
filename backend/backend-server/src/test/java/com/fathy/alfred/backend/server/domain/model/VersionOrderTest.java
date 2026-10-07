package com.fathy.alfred.backend.server.domain.model;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class VersionOrderTest {

    @Test
    void releasesAreNumbersHashBuildsAreNot() {
        assertThat(VersionOrder.isNumber("1.4.0")).isTrue();
        assertThat(VersionOrder.isNumber("v1.4.0")).isTrue();
        assertThat(VersionOrder.isNumber("1.4")).isTrue();
        assertThat(VersionOrder.isNumber("1.4.0-12-g87159af")).isTrue();
        assertThat(VersionOrder.isNumber("1.4.0-dirty")).isTrue();
        assertThat(VersionOrder.isNumber("87159af")).isFalse();
        assertThat(VersionOrder.isNumber("49c0c7b8-dirty")).isFalse();
        assertThat(VersionOrder.isNumber("")).isFalse();
        assertThat(VersionOrder.isNumber(null)).isFalse();
    }

    @Test
    void ordersNumberByNumberNotTextually() {
        assertThat(VersionOrder.compare("1.10.0", "1.9.0")).isPositive();
        assertThat(VersionOrder.compare("2.0", "1.99.99")).isPositive();
        assertThat(VersionOrder.compare("1.4.0", "v1.4")).isZero();
        assertThat(VersionOrder.compare("1.4.0", "1.4.1")).isNegative();
    }

    @Test
    void aReleaseIsAnUpdateForAnOlderReleaseAndForAnyHashBuild() {
        assertThat(VersionOrder.isNewer("1.5.0", "1.4.0")).isTrue();
        assertThat(VersionOrder.isNewer("1.5.0", "49c0c7b8-dirty")).isTrue();
        assertThat(VersionOrder.isNewer("1.4.0", "1.4.0")).isFalse();
        assertThat(VersionOrder.isNewer("1.3.0", "1.4.0")).isFalse();
    }

    @Test
    void aBuildPastAReleaseCountsAsThatReleaseSoTheReleaseIsNoUpdateForIt() {
        // 1.4.0-12-g87159af is twelve commits AFTER 1.4.0: offering 1.4.0 would downgrade it.
        assertThat(VersionOrder.isNewer("1.4.0", "1.4.0-12-g87159af")).isFalse();
        assertThat(VersionOrder.isNewer("1.4.1", "1.4.0-12-g87159af")).isTrue();
    }

    @Test
    void aHashIsNeverOfferedAsAnUpdate() {
        assertThat(VersionOrder.isNewer("f9a2d152", "49c0c7b8")).isFalse();
        assertThat(VersionOrder.isNewer("f9a2d152", "1.0.0")).isFalse();
        assertThat(VersionOrder.isNewer("", "1.0.0")).isFalse();
    }

    @Test
    void theInstallTargetMatchesTheInstallerNames() {
        assertThat(VersionOrder.installTarget()).isIn("windows-x64", "linux-x64");
    }
}
