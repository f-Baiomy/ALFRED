package com.fathy.alfred.backend.server.adapter.in.web.dto;

import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.domain.model.EnvProblem;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import com.fathy.alfred.backend.server.domain.model.SettingValue;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;

/** The wire shapes of contracts/server-api.md. Secrets never leave as values: {@code value} is null, {@code isSet} says. */
public final class SettingsDtos {

    /** Requests carry at most this many edits (Constitution I: every client-supplied size is capped). */
    public static final int MAX_EDITS = 64;

    private SettingsDtos() {
    }

    public record EditDto(@NotBlank @Size(max = 64) String key, @Size(max = 65_536) String value, boolean reset) {
        public SettingsChange.Edit toDomain() {
            return reset ? SettingsChange.Edit.reset(key) : SettingsChange.Edit.set(key, value);
        }
    }

    public record SaveRequest(@Size(max = 128) String baseHash, @NotNull @Size(max = MAX_EDITS) List<@Valid EditDto> edits) {
        public SettingsChange toDomain() {
            return new SettingsChange(baseHash, edits.stream().map(EditDto::toDomain).toList());
        }
    }

    public record SettingDto(String key, String group, String kind, String label, String help, String applies,
                             List<String> enumValues, Long min, Long max, String value, boolean isSet, String defaultValue,
                             String source, boolean differsFromDefault, PendingRestart pending) {

        public static SettingDto of(SettingValue v) {
            var d = v.definition();
            return new SettingDto(d.key(), d.group().name(), d.kind().name(), d.label(), d.help(), d.applies().name(),
                    d.enumValues(), d.min(), d.max(), v.value(), v.isSet(), v.defaultValue(), v.source().name(),
                    v.differsFromDefault(), v.pending());
        }
    }

    public record SettingsResponse(String mode, String envLocation, String envHash, List<SettingDto> settings,
                                   List<String> missingFromEnv, List<EnvProblem> unknownLines,
                                   List<PendingRestart> pendingRestart) {

        public static SettingsResponse of(GetSettingsUseCase.SettingsView view) {
            return new SettingsResponse(view.mode().name(), view.envLocation(), view.envHash(),
                    view.settings().stream().map(SettingDto::of).toList(), view.missingFromEnv(), view.unknownLines(),
                    view.pendingRestart());
        }
    }
}
