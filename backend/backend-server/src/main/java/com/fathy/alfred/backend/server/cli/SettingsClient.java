package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;

/**
 * What "alfred config" needs, from wherever the settings engine runs: the running backend over HTTP (so a change
 * applies live, exactly as from the UI) or, when it is stopped, the same service on the files (research R7).
 */
interface SettingsClient {

    /** One setting as the CLI shows it. Secrets carry no value. */
    record Setting(String key, String label, String kind, String applies, String value, boolean isSet, String source,
                   String defaultValue, boolean differsFromDefault) {
    }

    record View(String envHash, List<Setting> settings, List<String> missingFromEnv, List<String> unusedLines) {
    }

    record Applied(String key, String outcome, String detail) {
    }

    /** A refused save: what is wrong, or that .env changed meanwhile. */
    final class Refused extends RuntimeException {
        final List<ValidationResult> results;
        final boolean conflict;

        Refused(List<ValidationResult> results, boolean conflict, String message) {
            super(message);
            this.results = List.copyOf(results);
            this.conflict = conflict;
        }
    }

    View view();

    /** @throws Refused when a value is invalid or .env changed after {@code baseHash} */
    List<Applied> save(String baseHash, List<SettingsChange.Edit> edits);

    List<Applied> addMissing();

    List<ValidationResult> check(List<SettingsChange.Edit> edits, boolean all);

    List<HistoryEntry> history(int limit);

    List<SettingsChange.Edit> revert(long id);

    /** "live" (through the backend) or "files" (backend stopped). */
    String where();
}
