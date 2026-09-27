package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.application.port.out.VariablesChangedNotificationPort;
import org.junit.jupiter.api.Test;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class GlobalVariablesServiceTest {
    private final GlobalVariablesStorePort store = new GlobalVariablesStorePort() {
        private Map<String, Object> state = Map.of();
        @Override public Map<String, Object> load() { return state; }
        @Override public Map<String, Object> save(Map<String, Object> next) { state = next; return next; }
    };
    private final List<String> broadcasts = new ArrayList<>();
    private final VariablesChangedNotificationPort notifications = () -> broadcasts.add("changed");
    private final GlobalVariablesService service = new GlobalVariablesService(store, notifications);

    @Test void acceptsArbitraryTextAndNormalizesMissingMaps() {
        assertThat(service.get()).containsKeys("variables", "fallbacks");
        var saved = service.save(Map.of("variables", Map.of("account.id", "line 1\n{{other}}\n\"quoted\"")));
        assertThat(saved.get("variables")).isEqualTo(Map.of("account.id", "line 1\n{{other}}\n\"quoted\""));
        assertThat(saved.get("fallbacks")).isEqualTo(Map.of());
    }

    @Test void rejectsInvalidNamesAndNonTextValues() {
        assertThatThrownBy(() -> service.save(Map.of("variables", Map.of("1bad", "value"))))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.save(Map.of("variables", Map.of("good", 42))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test void saveBroadcasts() {
        service.save(Map.of("variables", Map.of("a", "1"), "fallbacks", Map.of()));
        assertThat(broadcasts).hasSize(1);
    }

    @Test void promoteMergesAndSupersedesFallbacks() {
        service.save(Map.of("variables", Map.of("kept", "v"), "fallbacks", Map.of("token", "fb")));
        broadcasts.clear();
        var promoted = service.promote("token", "NEW");
        assertThat(promoted.get("variables")).isEqualTo(Map.of("kept", "v", "token", "NEW"));
        assertThat(promoted.get("fallbacks")).isEqualTo(Map.of());
        assertThat(broadcasts).hasSize(1);
    }

    @Test void promoteRejectsBadNamesAndNonTextValues() {
        assertThatThrownBy(() -> service.promote("this.x", "v")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.promote("1bad", "v")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.promote("good", 42)).isInstanceOf(IllegalArgumentException.class);
        assertThat(broadcasts).isEmpty();
    }
}
