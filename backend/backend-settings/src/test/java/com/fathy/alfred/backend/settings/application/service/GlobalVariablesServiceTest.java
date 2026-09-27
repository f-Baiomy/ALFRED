package com.fathy.alfred.backend.settings.application.service;

import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.application.port.out.VariablesChangedNotificationPort;
import org.junit.jupiter.api.Test;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class GlobalVariablesServiceTest {
    private static final class InMemoryStore implements GlobalVariablesStorePort {
        private Map<String, Object> state = Map.of();
        @Override public synchronized Map<String, Object> load() { return state; }
        @Override public synchronized Map<String, Object> save(Map<String, Object> next) { state = next; return next; }
        @Override public synchronized Update update(java.util.function.UnaryOperator<Map<String, Object>> change) {
            Map<String, Object> current = load();
            Map<String, Object> next = change.apply(current);
            if (next.equals(current)) return new Update(current, false);
            return new Update(save(next), true);
        }
    }

    private final InMemoryStore store = new InMemoryStore();
    private final List<String> broadcasts = new ArrayList<>();
    private final VariablesChangedNotificationPort notifications = () -> broadcasts.add("changed");
    private final AtomicLong nowMillis = new AtomicLong(1_000L);
    private final Clock clock = new Clock() {
        @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(nowMillis.getAndIncrement()); }
    };
    private final GlobalVariablesService service = new GlobalVariablesService(store, notifications, clock);

    @SuppressWarnings("unchecked")
    private Map<String, Long> updatedAtOf(Map<String, Object> state) {
        return (Map<String, Long>) state.get("updatedAt");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> sourcesOf(Map<String, Object> state) {
        return (Map<String, Object>) state.get("sources");
    }

    @Test void getReturnsTheDefaultEnvironmentByDefault() {
        Map<String, Object> state = service.get();
        assertThat(state).containsKeys("variables", "fallbacks", "updatedAt", "sources", "secrets", "activeEnvironment", "environments");
        assertThat(state.get("activeEnvironment")).isEqualTo("Default");
        assertThat(state.get("environments")).isEqualTo(List.of("Default"));
        assertThat(state.get("secrets")).isEqualTo(List.of());
    }

    @Test void acceptsArbitraryTextAndNormalizesMissingMaps() {
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

    @Test void saveBroadcastsAndMarksSourceManual() {
        var saved = service.save(Map.of("variables", Map.of("a", "1"), "fallbacks", Map.of()));
        assertThat(broadcasts).hasSize(1);
        assertThat(sourcesOf(saved).get("a")).isEqualTo(Map.of("kind", "MANUAL"));
    }

    @Test void saveIsANoOpWhenNothingActuallyChanges() {
        service.save(Map.of("variables", Map.of("a", "1"), "fallbacks", Map.of()));
        broadcasts.clear();
        service.save(Map.of("variables", Map.of("a", "1"), "fallbacks", Map.of()));
        assertThat(broadcasts).isEmpty();
    }

    @Test void saveBumpsUpdatedAtOnlyForNamesThatActuallyChanged() {
        service.save(Map.of("variables", Map.of("a", "1", "b", "1"), "fallbacks", Map.of()));
        var firstUpdatedAt = updatedAtOf(service.get());
        long aTime = firstUpdatedAt.get("a");
        long bTime = firstUpdatedAt.get("b");

        var saved = service.save(Map.of("variables", Map.of("a", "1", "b", "2"), "fallbacks", Map.of()));
        var secondUpdatedAt = updatedAtOf(saved);
        assertThat(secondUpdatedAt.get("a")).isEqualTo(aTime);
        assertThat(secondUpdatedAt.get("b")).isGreaterThan(bTime);
    }

    @Test void promoteMergesAndSupersedesFallbacksWithCaptureSource() {
        service.save(Map.of("variables", Map.of("kept", "v"), "fallbacks", Map.of("token", "fb")));
        broadcasts.clear();
        var promoted = service.promote("token", "NEW", "r-1", "Login token");
        assertThat(promoted.get("variables")).isEqualTo(Map.of("kept", "v", "token", "NEW"));
        assertThat(promoted.get("fallbacks")).isEqualTo(Map.of());
        assertThat(sourcesOf(promoted).get("token")).isEqualTo(Map.of("kind", "CAPTURE", "ruleId", "r-1", "ruleName", "Login token"));
        assertThat(broadcasts).hasSize(1);
    }

    @Test void promoteRejectsBadNamesAndNonTextValues() {
        assertThatThrownBy(() -> service.promote("this.x", "v", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.promote("1bad", "v", null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.promote("good", 42, null, null)).isInstanceOf(IllegalArgumentException.class);
        assertThat(broadcasts).isEmpty();
    }

    @Test void upsertSetsVariableClearsFallbackAndMarksManual() {
        service.save(Map.of("variables", Map.of(), "fallbacks", Map.of("token", "fb")));
        broadcasts.clear();
        var result = service.upsert("token", "NEW");
        assertThat(result.get("variables")).isEqualTo(Map.of("token", "NEW"));
        assertThat(result.get("fallbacks")).isEqualTo(Map.of());
        assertThat(sourcesOf(result).get("token")).isEqualTo(Map.of("kind", "MANUAL"));
        assertThat(broadcasts).hasSize(1);
    }

    @Test void upsertRejectsBadNames() {
        assertThatThrownBy(() -> service.upsert("this.x", "v")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.upsert("1bad", "v")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void removeDropsVariableKeepsTombstoneAndDropsSource() {
        service.upsert("token", "v");
        broadcasts.clear();
        var result = service.remove("token", null);
        assertThat(result.get("variables")).isEqualTo(Map.of());
        assertThat(updatedAtOf(result)).containsKey("token");
        assertThat(sourcesOf(result)).doesNotContainKey("token");
        assertThat(broadcasts).hasSize(1);
    }

    @Test void removeCanSetAFallback() {
        service.upsert("token", "v");
        var result = service.remove("token", "fb");
        assertThat(result.get("fallbacks")).isEqualTo(Map.of("token", "fb"));
    }

    @Test void removeRejectsBadNames() {
        assertThatThrownBy(() -> service.remove("this.x", null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void enforcesCombinedNameCapPerEnvironment() {
        Map<String, Object> variables = new java.util.HashMap<>();
        for (int i = 0; i < 1000; i++) variables.put("v" + i, "x");
        service.save(Map.of("variables", variables, "fallbacks", Map.of()));
        assertThatThrownBy(() -> service.upsert("oneMore", "x")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void enforcesPerValueSizeCap() {
        String tooBig = "x".repeat(1_048_577);
        assertThatThrownBy(() -> service.upsert("name", tooBig)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.promote("name", tooBig, null, null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void setSecretAddsAndRemovesFromTheGlobalList() {
        var withSecret = service.setSecret("apiKey", true);
        assertThat(withSecret.get("secrets")).isEqualTo(List.of("apiKey"));
        var without = service.setSecret("apiKey", false);
        assertThat(without.get("secrets")).isEqualTo(List.of());
    }

    @Test void setSecretWorksForANameThatDoesNotExistYet() {
        var result = service.setSecret("neverCreated", true);
        assertThat(result.get("secrets")).isEqualTo(List.of("neverCreated"));
    }

    @Test void createEnvironmentAddsButNeverActivates() {
        var result = service.createEnvironment("Staging", null);
        assertThat(result.get("environments")).isEqualTo(List.of("Default", "Staging"));
        assertThat(result.get("activeEnvironment")).isEqualTo("Default");
    }

    @Test void createEnvironmentCanCopyFromAnother() {
        service.upsert("token", "v");
        var result = service.createEnvironment("Staging", "Default");
        var view = service.get();
        assertThat(view.get("environments")).isEqualTo(List.of("Default", "Staging"));
        // Still viewing Default (not activated) - switch and check the copy landed.
        service.activateEnvironment("Staging");
        assertThat(service.get().get("variables")).isEqualTo(Map.of("token", "v"));
    }

    @Test void createEnvironmentRejectsADuplicateName() {
        assertThatThrownBy(() -> service.createEnvironment("Default", null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void createEnvironmentRejectsAnInvalidName() {
        assertThatThrownBy(() -> service.createEnvironment("", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.createEnvironment(" leading-space", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.createEnvironment("x".repeat(41), null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void createEnvironmentEnforcesTheMaxCount() {
        for (int i = 0; i < 19; i++) service.createEnvironment("Env" + i, null);
        assertThat(service.get().get("environments")).asList().hasSize(20);
        assertThatThrownBy(() -> service.createEnvironment("OneTooMany", null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void activateSwitchesTheActiveEnvironment() {
        service.createEnvironment("Staging", null);
        var result = service.activateEnvironment("Staging");
        assertThat(result.get("activeEnvironment")).isEqualTo("Staging");
    }

    @Test void activateRejectsAnUnknownEnvironment() {
        assertThatThrownBy(() -> service.activateEnvironment("Missing")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void deleteRejectsTheActiveEnvironment() {
        service.createEnvironment("Staging", null);
        assertThatThrownBy(() -> service.deleteEnvironment("Default")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void deleteRejectsTheLastEnvironment() {
        assertThatThrownBy(() -> service.deleteEnvironment("Default")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void deleteRemovesANonActiveEnvironment() {
        service.createEnvironment("Staging", null);
        var result = service.deleteEnvironment("Staging");
        assertThat(result.get("environments")).isEqualTo(List.of("Default"));
    }

    @Test void exportReturnsNameVariablesAndFallbacks() {
        service.upsert("token", "v");
        var exported = service.exportEnvironment("Default");
        assertThat(exported).isEqualTo(Map.of("name", "Default", "variables", Map.of("token", "v"), "fallbacks", Map.of()));
    }

    @Test void exportRejectsAnUnknownEnvironment() {
        assertThatThrownBy(() -> service.exportEnvironment("Missing")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test void importMergeUpsertsOntoWhatIsThereAndTagsSourceImport() {
        service.upsert("kept", "old");
        var result = service.importEnvironment("Default", Map.of("kept", "new", "added", "v"), null, "MERGE");
        assertThat(result.get("variables")).isEqualTo(Map.of("kept", "new", "added", "v"));
        assertThat(sourcesOf(result).get("added")).isEqualTo(Map.of("kind", "IMPORT"));
    }

    @Test void importReplaceWipesWhatWasThereBefore() {
        service.upsert("old", "v");
        var result = service.importEnvironment("Default", Map.of("fresh", "v"), null, "REPLACE");
        assertThat(result.get("variables")).isEqualTo(Map.of("fresh", "v"));
    }

    @Test void importCreatesTheEnvironmentIfAbsent() {
        var result = service.importEnvironment("Imported", Map.of("token", "v"), null, "MERGE");
        assertThat(result.get("environments")).isEqualTo(List.of("Default", "Imported"));
    }

    @Test void importRejectsAnUnknownMode() {
        assertThatThrownBy(() -> service.importEnvironment("Default", Map.of(), null, "BOGUS"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    /**
     * Reproduces the bug directly: {@code promote} used to do an unsynchronized
     * {@code store.load()} then {@code store.save()}, so a concurrent per-name UI edit
     * ({@code upsert}, the same load-modify-save shape) landing in between was silently
     * overwritten and lost. With both routed through {@code store.update()}'s single lock,
     * whichever runs second always builds on the first's already-committed result, so both
     * additions survive regardless of interleaving.
     */
    @Test void concurrentPromoteAndUpsertBothSurvive() throws InterruptedException {
        service.upsert("existing", "v");
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch go = new CountDownLatch(1);
        Thread promoter = new Thread(() -> {
            ready.countDown();
            await(go);
            service.promote("fromProxy", "promoted-value", null, null);
        });
        Thread editor = new Thread(() -> {
            ready.countDown();
            await(go);
            service.upsert("fromUi", "ui-value");
        });
        promoter.start();
        editor.start();
        ready.await(5, TimeUnit.SECONDS);
        go.countDown();
        promoter.join(5000);
        editor.join(5000);

        @SuppressWarnings("unchecked")
        Map<String, Object> variables = (Map<String, Object>) service.get().get("variables");
        assertThat(variables).containsEntry("existing", "v")
                .containsEntry("fromProxy", "promoted-value")
                .containsEntry("fromUi", "ui-value");
    }

    private static void await(CountDownLatch latch) {
        try { latch.await(5, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}
