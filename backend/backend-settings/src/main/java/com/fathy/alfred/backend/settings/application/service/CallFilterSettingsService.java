package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.in.GetCallFilterSettingsUseCase;
import com.fathy.alfred.backend.settings.application.port.in.IsCallAllowedUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageBlacklistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageWhitelistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.SetFilterModeUseCase;
import com.fathy.alfred.backend.settings.application.port.out.FilterSettingsStorePort;
import com.fathy.alfred.backend.settings.domain.HostNormalizer;
import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;

@Service
public class CallFilterSettingsService implements
        GetCallFilterSettingsUseCase,
        SetFilterModeUseCase,
        ManageWhitelistUseCase,
        ManageBlacklistUseCase,
        IsCallAllowedUseCase {

    private final FilterSettingsStorePort store;

    public CallFilterSettingsService(FilterSettingsStorePort store) {
        this.store = store;
    }

    @Override
    public CallFilterSettings getSettings() {
        return store.load();
    }

    @Override
    public CallFilterSettings setMode(FilterMode mode) {
        CallFilterSettings current = store.load();
        return store.save(new CallFilterSettings(mode, current.whitelist(), current.blacklist()));
    }

    @Override
    public CallFilterSettings addWhitelistUrl(String host) {
        CallFilterSettings current = store.load();
        String normalized = HostNormalizer.normalize(host);
        if (normalized.isEmpty() || containsHost(current.whitelist(), normalized)) {
            return current;
        }
        List<UrlRule> updated = append(current.whitelist(), new UrlRule(UUID.randomUUID().toString(), normalized, true));
        return store.save(new CallFilterSettings(current.mode(), updated, current.blacklist()));
    }

    @Override
    public CallFilterSettings toggleWhitelistUrl(String id, boolean enabled) {
        CallFilterSettings current = store.load();
        List<UrlRule> updated = current.whitelist().stream()
                .map(rule -> rule.id().equals(id) ? new UrlRule(rule.id(), rule.host(), enabled) : rule)
                .toList();
        return store.save(new CallFilterSettings(current.mode(), updated, current.blacklist()));
    }

    @Override
    public CallFilterSettings removeWhitelistUrl(String id) {
        CallFilterSettings current = store.load();
        List<UrlRule> updated = current.whitelist().stream().filter(rule -> !rule.id().equals(id)).toList();
        return store.save(new CallFilterSettings(current.mode(), updated, current.blacklist()));
    }

    @Override
    public CallFilterSettings addBlacklistUrl(String host) {
        CallFilterSettings current = store.load();
        String normalized = HostNormalizer.normalize(host);
        if (normalized.isEmpty() || containsHost(current.blacklist(), normalized)) {
            return current;
        }
        List<UrlRule> updated = append(current.blacklist(), new UrlRule(UUID.randomUUID().toString(), normalized, true));
        return store.save(new CallFilterSettings(current.mode(), current.whitelist(), updated));
    }

    @Override
    public CallFilterSettings removeBlacklistUrl(String id) {
        CallFilterSettings current = store.load();
        List<UrlRule> updated = current.blacklist().stream().filter(rule -> !rule.id().equals(id)).toList();
        return store.save(new CallFilterSettings(current.mode(), current.whitelist(), updated));
    }

    /**
     * Blacklist always wins regardless of mode. Otherwise ACCEPT_ALL passes everything through,
     * and ACCEPT_ONLY requires a matching *enabled* whitelist entry - a disabled entry is treated
     * exactly as if it weren't in the list at all.
     */
    @Override
    public boolean isAllowed(String url) {
        CallFilterSettings settings = store.load();
        String host = HostNormalizer.normalize(url);

        if (containsHost(settings.blacklist(), host)) {
            return false;
        }
        if (settings.mode() == FilterMode.ACCEPT_ALL) {
            return true;
        }
        return settings.whitelist().stream().anyMatch(rule -> rule.enabled() && rule.host().equals(host));
    }

    private static boolean containsHost(List<UrlRule> rules, String host) {
        return rules.stream().anyMatch(rule -> rule.host().equals(host));
    }

    private static List<UrlRule> append(List<UrlRule> rules, UrlRule rule) {
        List<UrlRule> updated = new java.util.ArrayList<>(rules);
        updated.add(rule);
        return updated;
    }
}
