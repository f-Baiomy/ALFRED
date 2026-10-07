package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.PreviewSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.SettingValue;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.Source;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static com.fathy.alfred.backend.server.domain.model.SettingsChange.Edit.reset;
import static com.fathy.alfred.backend.server.domain.model.SettingsChange.Edit.set;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ServerSettingsServiceTest {

    private static final String ENV = String.join("\n",
            "# --- Inbound projects ---",
            "REVERSE_PROXY_ENABLED=true",
            "INTERNAL_CALLS_RETENTION_ROWS=5000",
            "BACKEND_PORT=5000",
            "WEBHOOK_SECRET=abc",
            "ALFRED_MEMORY=2g", "") ;

    private static SettingValue value(GetSettingsUseCase.SettingsView view, String key) {
        return view.settings().stream().filter(v -> v.definition().key().equals(key)).findFirst().orElseThrow();
    }

    private static SettingsChange change(Fakes.Rig rig, SettingsChange.Edit... edits) {
        return new SettingsChange(rig.env.read().contentHash(), List.of(edits));
    }

    // ---- read (US2) ---------------------------------------------------------------------------------------------------

    @Test
    void envValuesWinAndMissingKeysUseTheirDefault() {
        var view = new Fakes.Rig(ENV).service.settings();
        assertThat(value(view, "INTERNAL_CALLS_RETENTION_ROWS")).satisfies(v -> {
            assertThat(v.value()).isEqualTo("5000");
            assertThat(v.source()).isEqualTo(Source.ENV_FILE);
            assertThat(v.differsFromDefault()).isTrue();
        });
        assertThat(value(view, "ALFRED_UI_PORT")).satisfies(v -> {
            assertThat(v.value()).isEqualTo("3000");
            assertThat(v.source()).isEqualTo(Source.DEFAULT);
        });
        assertThat(view.missingFromEnv()).contains("ALFRED_UI_PORT").doesNotContain("ALFRED_MEMORY");
        assertThat(view.unknownLines()).singleElement().satisfies(p -> assertThat(p.text()).isEqualTo("BACKEND_PORT=5000"));
    }

    @Test
    void secretsAreNeverReturned() {
        var secret = value(new Fakes.Rig(ENV).service.settings(), "WEBHOOK_SECRET");
        assertThat(secret.value()).isNull();
        assertThat(secret.defaultValue()).isNull();
        assertThat(secret.isSet()).isTrue();
    }

    @Test
    void dockerModeShowsTheContainersValuesReadOnly() {
        var rig = new Fakes.Rig(null, RuntimeMode.DOCKER, Map.of("INTERNAL_CALLS_RETENTION_ROWS", "1500"));
        var view = rig.service.settings();
        assertThat(value(view, "INTERNAL_CALLS_RETENTION_ROWS").source()).isEqualTo(Source.PROCESS_ENV);
        assertThat(value(view, "ALFRED_UI_PORT").value()).isNull();
        assertThat(view.missingFromEnv()).isEmpty();
        assertThatThrownBy(() -> rig.service.save(new SettingsChange(null, List.of(set("ALFRED_MEMORY", "3g"))),
                HistoryEntry.HistorySource.UI, "x")).isInstanceOf(IllegalStateException.class);
    }

    // ---- preview / save (US3) -----------------------------------------------------------------------------------------

    @Test
    void previewShowsLinesBeforeAndAfterAndWritesNothing() {
        var rig = new Fakes.Rig(ENV);
        PreviewSettingsUseCase.Preview preview = rig.service.preview(change(rig,
                set("INTERNAL_CALLS_RETENTION_ROWS", "8000"), set("ALFRED_UI_PORT", "3100"), set("WEBHOOK_SECRET", "new")));
        assertThat(preview.diff()).extracting(PreviewSettingsUseCase.DiffLine::before, PreviewSettingsUseCase.DiffLine::after)
                .containsExactly(
                        org.assertj.core.groups.Tuple.tuple("INTERNAL_CALLS_RETENTION_ROWS=5000", "INTERNAL_CALLS_RETENTION_ROWS=8000"),
                        org.assertj.core.groups.Tuple.tuple(null, "ALFRED_UI_PORT=3100"),
                        org.assertj.core.groups.Tuple.tuple("WEBHOOK_SECRET=<set>", "WEBHOOK_SECRET=<set>"));
        assertThat(rig.env.content).isEqualTo(ENV);
    }

    @Test
    void anInvalidValueRefusesTheWholeSaveAndWritesNothing() {
        var rig = new Fakes.Rig(ENV);
        assertThatThrownBy(() -> rig.service.save(change(rig, set("INTERNAL_CALLS_RETENTION_ROWS", "8000"),
                set("ALFRED_MEMORY", "lots")), HistoryEntry.HistorySource.UI, "127.0.0.1"))
                .isInstanceOf(SaveSettingsUseCase.SettingsRefusedException.class);
        assertThat(rig.env.content).isEqualTo(ENV);
        assertThat(rig.history.entries).isEmpty();
    }

    @Test
    void aChangedFileIsAConflictNamingWhatChanged() {
        var rig = new Fakes.Rig(ENV);
        rig.service.save(change(rig, set("INTERNAL_CALLS_RETENTION_ROWS", "6000")), HistoryEntry.HistorySource.UI, "x");
        String loadedHash = rig.env.read().contentHash();
        rig.env.content = rig.env.content.replace("REVERSE_PROXY_ENABLED=true", "REVERSE_PROXY_ENABLED=false");

        assertThatThrownBy(() -> rig.service.save(new SettingsChange(loadedHash, List.of(set("ALFRED_MEMORY", "3g"))),
                HistoryEntry.HistorySource.UI, "x"))
                .isInstanceOfSatisfying(SaveSettingsUseCase.SettingsConflictException.class,
                        e -> assertThat(e.changedKeys()).containsExactly("REVERSE_PROXY_ENABLED"));
        assertThat(rig.env.content).doesNotContain("ALFRED_MEMORY=3g");
        assertThat(rig.history.entries).last().satisfies(e -> assertThat(e.source()).isEqualTo(HistoryEntry.HistorySource.HAND_EDIT));
    }

    @Test
    void eachChangeAppliesTheWayItsSettingSays() {
        var rig = new Fakes.Rig(ENV);
        SaveSettingsUseCase.Saved saved = rig.service.save(change(rig,
                set("INTERNAL_CALLS_RETENTION_ROWS", "8000"),
                set("INTERNAL_CALL_SERVICES", "a:9001:8080"),
                set("ALFRED_MEMORY", "3G")), HistoryEntry.HistorySource.UI, "192.168.1.23");

        assertThat(saved.applied()).extracting(SaveSettingsUseCase.Applied::key, SaveSettingsUseCase.Applied::outcome)
                .containsExactlyInAnyOrder(
                        org.assertj.core.groups.Tuple.tuple("INTERNAL_CALLS_RETENTION_ROWS", SaveSettingsUseCase.Outcome.APPLIED),
                        org.assertj.core.groups.Tuple.tuple("INTERNAL_CALL_SERVICES", SaveSettingsUseCase.Outcome.PROXIES_RESTARTED),
                        org.assertj.core.groups.Tuple.tuple("ALFRED_MEMORY", SaveSettingsUseCase.Outcome.PENDING_RESTART));
        assertThat(rig.live.applied).containsExactly("INTERNAL_CALLS_RETENTION_ROWS=8000");
        assertThat(rig.supervisor.reloads).isEqualTo(1);
        assertThat(rig.pending.list).singleElement().satisfies(p -> {
            assertThat(p.before()).isEqualTo("2g");
            assertThat(p.after()).isEqualTo("3g");
        });
        assertThat(rig.env.content).contains("ALFRED_MEMORY=3g").contains("INTERNAL_CALL_SERVICES=a:9001:8080")
                .startsWith("# --- Inbound projects ---\nREVERSE_PROXY_ENABLED=true\nINTERNAL_CALLS_RETENTION_ROWS=8000\n");
        assertThat(rig.history.entries).singleElement().satisfies(e -> {
            assertThat(e.source()).isEqualTo(HistoryEntry.HistorySource.UI);
            assertThat(e.sourceDetail()).isEqualTo("192.168.1.23");
            assertThat(e.changes()).hasSize(3);
        });
        assertThat(rig.events.sent).containsExactly("settings");
    }

    @Test
    void savingTheOldValueBackClearsItsPendingRestart() {
        var rig = new Fakes.Rig(ENV);
        rig.service.save(change(rig, set("ALFRED_MEMORY", "3g")), HistoryEntry.HistorySource.UI, "x");
        rig.service.save(change(rig, set("ALFRED_MEMORY", "2g")), HistoryEntry.HistorySource.UI, "x");
        assertThat(rig.pending.list).isEmpty();
    }

    @Test
    void resetRemovesTheLineAndTheDefaultAppliesAgain() {
        var rig = new Fakes.Rig(ENV);
        rig.service.save(change(rig, reset("INTERNAL_CALLS_RETENTION_ROWS")), HistoryEntry.HistorySource.CLI, "fathy");
        assertThat(rig.env.content).doesNotContain("INTERNAL_CALLS_RETENTION_ROWS");
        assertThat(rig.live.applied).containsExactly("INTERNAL_CALLS_RETENTION_ROWS=1500");
        assertThat(rig.history.entries.get(0).changes().get(0).after()).isNull();
    }

    @Test
    void secretsAreRecordedAsChangedNeverByValue() {
        var rig = new Fakes.Rig(ENV);
        rig.service.save(change(rig, set("WEBHOOK_SECRET", "s3cret")), HistoryEntry.HistorySource.UI, "x");
        assertThat(rig.history.entries.get(0).changes().get(0)).satisfies(c -> {
            assertThat(c.before()).isEqualTo("set");
            assertThat(c.after()).isEqualTo("changed");
        });
        assertThat(rig.pending.list.get(0).after()).isEqualTo("<set>");
    }

    @Test
    void addMissingWritesEveryAbsentKeyWithItsDefault() {
        var rig = new Fakes.Rig(ENV);
        rig.service.addMissing(HistoryEntry.HistorySource.UI, "x");
        assertThat(rig.service.settings().missingFromEnv()).isEmpty();
        assertThat(rig.env.content).contains("ALFRED_UI_PORT=3000").contains("# --- Network");
    }

    @Test
    void withoutASupervisorProxyChangesWaitForARestart() {
        var rig = new Fakes.Rig(ENV);
        rig.supervisor.available = false;
        var saved = rig.service.save(change(rig, set("REVERSE_PROXY_ENABLED", "false")), HistoryEntry.HistorySource.UI, "x");
        assertThat(saved.applied()).singleElement().satisfies(a -> assertThat(a.outcome()).isEqualTo(SaveSettingsUseCase.Outcome.SAVED));
    }

    @Test
    void settingsPropertiesIsNeverWritten() {
        // The service only has the .env port to write to; defaults are read-only by construction (FR-013).
        var rig = new Fakes.Rig(ENV);
        rig.service.save(change(rig, set("ALFRED_MEMORY", "3g")), HistoryEntry.HistorySource.UI, "x");
        assertThat(Fakes.DEFAULTS.get("ALFRED_MEMORY")).isEqualTo("2g");
    }
}
