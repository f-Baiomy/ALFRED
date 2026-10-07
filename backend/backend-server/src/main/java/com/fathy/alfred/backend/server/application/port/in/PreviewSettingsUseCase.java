package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.ApplyMode;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;

/** The review before a save (FR-024): each affected .env line before and after, and how each change applies. Writes nothing. */
public interface PreviewSettingsUseCase {

    /** {@code before}/{@code after} are whole .env lines; null when the line is added or removed. Secrets are masked. */
    record DiffLine(String key, String before, String after) {
    }

    record Effect(String key, ApplyMode applies) {
    }

    record Preview(List<DiffLine> diff, List<Effect> effects, List<ValidationResult> results) {
    }

    Preview preview(SettingsChange change);
}
