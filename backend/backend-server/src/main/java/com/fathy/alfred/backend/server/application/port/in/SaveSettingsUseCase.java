package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.ApplyMode;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;

/**
 * Saves edits to .env and applies them (FR-024/025): LIVE settings at once through the owning slices, proxy settings
 * by one restart of the proxies, RESTART settings recorded as waiting for a restart.
 */
public interface SaveSettingsUseCase {

    enum Outcome { APPLIED, PROXIES_RESTARTED, PENDING_RESTART, SAVED }

    record Applied(String key, ApplyMode applies, Outcome outcome, long tookMs, String detail) {
    }

    record Saved(String envHash, List<Applied> applied, long historyId) {
    }

    /** Some value is invalid (an ERROR result): nothing was written (FR-031). */
    class SettingsRefusedException extends RuntimeException {
        private final List<ValidationResult> results;

        public SettingsRefusedException(List<ValidationResult> results) {
            super("Some values are not valid - nothing was saved");
            this.results = List.copyOf(results);
        }

        public List<ValidationResult> results() {
            return results;
        }
    }

    /** .env changed after it was loaded (FR-036): nothing was written; {@code changedKeys} says what changed. */
    class SettingsConflictException extends RuntimeException {
        private final List<String> changedKeys;
        private final String currentHash;

        public SettingsConflictException(List<String> changedKeys, String currentHash) {
            super(".env was changed on the server after it was loaded");
            this.changedKeys = List.copyOf(changedKeys);
            this.currentHash = currentHash;
        }

        public List<String> changedKeys() {
            return changedKeys;
        }

        public String currentHash() {
            return currentHash;
        }
    }

    Saved save(SettingsChange change, HistoryEntry.HistorySource source, String sourceDetail);

    /** Writes every catalog key that is missing from .env with its default (FR-026). */
    Saved addMissing(HistoryEntry.HistorySource source, String sourceDetail);
}
