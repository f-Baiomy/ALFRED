package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.out.FilterSettingsStorePort;
import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class CallFilterSettingsServiceTest {

    /** A trivial in-memory fake standing in for the real file adapter - the service's own logic (not persistence) is what's under test here. */
    private static class FakeStore implements FilterSettingsStorePort {
        private CallFilterSettings settings = CallFilterSettings.defaults();

        @Override
        public CallFilterSettings load() {
            return settings;
        }

        @Override
        public CallFilterSettings save(CallFilterSettings settings) {
            this.settings = settings;
            return settings;
        }

        @Override
        public long storageSizeBytes() {
            return 0L;
        }
    }

    private final FakeStore store = new FakeStore();
    private final CallFilterSettingsService service = new CallFilterSettingsService(store);

    @Test
    void defaultsToAcceptAllWithEmptyLists() {
        CallFilterSettings settings = service.getSettings();

        assertThat(settings.mode()).isEqualTo(FilterMode.ACCEPT_ALL);
        assertThat(settings.whitelist()).isEmpty();
        assertThat(settings.blacklist()).isEmpty();
    }

    @Test
    void isAllowedReturnsTrueForEverythingInAcceptAllModeWithNoBlacklist() {
        assertThat(service.isAllowed("https://any-supplier.com/api/x")).isTrue();
    }

    @Test
    void isAllowedReturnsFalseForABlacklistedHostRegardlessOfMode() {
        service.addBlacklistUrl("https://blocked.com/foo");

        assertThat(service.isAllowed("https://blocked.com/anything")).isFalse();
        assertThat(service.isAllowed("http://blocked.com:8443/other?x=1")).isFalse();
    }

    @Test
    void isAllowedReturnsTrueForANonBlacklistedHostInAcceptAllMode() {
        service.addBlacklistUrl("blocked.com");

        assertThat(service.isAllowed("https://allowed.com/foo")).isTrue();
    }

    @Test
    void isAllowedInAcceptOnlyModeRequiresAnEnabledWhitelistMatch() {
        service.setMode(FilterMode.ACCEPT_ONLY);
        service.addWhitelistUrl("allowed.com");

        assertThat(service.isAllowed("https://allowed.com/api/x")).isTrue();
        assertThat(service.isAllowed("https://not-allowed.com/api/x")).isFalse();
    }

    @Test
    void isAllowedInAcceptOnlyModeTreatsADisabledWhitelistEntryAsAbsent() {
        service.setMode(FilterMode.ACCEPT_ONLY);
        CallFilterSettings afterAdd = service.addWhitelistUrl("allowed.com");
        String ruleId = afterAdd.whitelist().get(0).id();

        service.toggleWhitelistUrl(ruleId, false);

        assertThat(service.isAllowed("https://allowed.com/api/x")).isFalse();

        service.toggleWhitelistUrl(ruleId, true);

        assertThat(service.isAllowed("https://allowed.com/api/x")).isTrue();
    }

    @Test
    void isAllowedInAcceptOnlyModeStillHonorsTheBlacklistFirst() {
        service.setMode(FilterMode.ACCEPT_ONLY);
        service.addWhitelistUrl("allowed.com");
        service.addBlacklistUrl("allowed.com");

        assertThat(service.isAllowed("https://allowed.com/api/x")).isFalse();
    }

    @Test
    void addWhitelistUrlNormalizesAndDeduplicatesByHost() {
        service.addWhitelistUrl("https://Example.com/foo?x=1");
        CallFilterSettings settings = service.addWhitelistUrl("example.com");

        assertThat(settings.whitelist()).hasSize(1);
        assertThat(settings.whitelist().get(0).host()).isEqualTo("example.com");
        assertThat(settings.whitelist().get(0).enabled()).isTrue();
    }

    @Test
    void addBlacklistUrlNormalizesAndDeduplicatesByHost() {
        service.addBlacklistUrl("HTTP://Example.com:8080/foo");
        CallFilterSettings settings = service.addBlacklistUrl("example.com/bar");

        assertThat(settings.blacklist()).hasSize(1);
        assertThat(settings.blacklist().get(0).host()).isEqualTo("example.com");
    }

    @Test
    void removeWhitelistUrlRemovesOnlyTheMatchingEntry() {
        service.addWhitelistUrl("a.com");
        CallFilterSettings afterAdd = service.addWhitelistUrl("b.com");
        String idToRemove = afterAdd.whitelist().stream().filter(r -> r.host().equals("a.com")).findFirst().orElseThrow().id();

        CallFilterSettings settings = service.removeWhitelistUrl(idToRemove);

        assertThat(settings.whitelist()).extracting(UrlRule::host).containsExactly("b.com");
    }

    @Test
    void removeBlacklistUrlRemovesOnlyTheMatchingEntry() {
        service.addBlacklistUrl("a.com");
        CallFilterSettings afterAdd = service.addBlacklistUrl("b.com");
        String idToRemove = afterAdd.blacklist().stream().filter(r -> r.host().equals("a.com")).findFirst().orElseThrow().id();

        CallFilterSettings settings = service.removeBlacklistUrl(idToRemove);

        assertThat(settings.blacklist()).extracting(UrlRule::host).containsExactly("b.com");
    }

    @Test
    void setModeUpdatesModeWithoutTouchingTheLists() {
        service.addWhitelistUrl("a.com");

        CallFilterSettings settings = service.setMode(FilterMode.ACCEPT_ONLY);

        assertThat(settings.mode()).isEqualTo(FilterMode.ACCEPT_ONLY);
        assertThat(settings.whitelist()).extracting(UrlRule::host).containsExactly("a.com");
    }

    @Test
    void addingABlankOrUnparseableHostIsANoOp() {
        CallFilterSettings settings = service.addWhitelistUrl("   ");

        assertThat(settings.whitelist()).isEmpty();
    }
}
