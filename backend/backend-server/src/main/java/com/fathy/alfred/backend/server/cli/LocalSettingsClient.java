package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.application.service.ServerSettingsService;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingValue;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.util.List;

/** The settings service on the files, for when the backend is stopped: changes take effect at the next start. */
final class LocalSettingsClient implements SettingsClient {

    private final ServerSettingsService service;
    private final String user;

    LocalSettingsClient(ServerSettingsService service, String user) {
        this.service = service;
        this.user = user;
    }

    @Override
    public View view() {
        GetSettingsUseCase.SettingsView view = service.settings();
        return new View(view.envHash(), view.settings().stream().map(LocalSettingsClient::setting).toList(),
                view.missingFromEnv(), view.unknownLines().stream().map(p -> "line " + p.line() + ": \"" + p.text() + "\" (" + p.reason() + ")").toList());
    }

    private static Setting setting(SettingValue v) {
        var d = v.definition();
        return new Setting(d.key(), d.label(), d.kind().name(), d.applies().name(), v.value(), v.isSet(), v.source().name(),
                v.defaultValue(), v.differsFromDefault());
    }

    @Override
    public List<Applied> save(String baseHash, List<SettingsChange.Edit> edits) {
        try {
            return applied(service.save(new SettingsChange(baseHash, edits), HistoryEntry.HistorySource.CLI, user));
        } catch (SaveSettingsUseCase.SettingsRefusedException e) {
            throw new Refused(e.results(), false, e.getMessage());
        } catch (SaveSettingsUseCase.SettingsConflictException e) {
            throw new Refused(List.of(), true, e.getMessage());
        }
    }

    @Override
    public List<Applied> addMissing() {
        return applied(service.addMissing(HistoryEntry.HistorySource.CLI, user));
    }

    private static List<Applied> applied(SaveSettingsUseCase.Saved saved) {
        // The backend is not running: whatever the setting's kind, it is read at the next start.
        return saved.applied().stream().map(a -> new Applied(a.key(), "SAVED", "takes effect when Alfred starts")).toList();
    }

    @Override
    public List<ValidationResult> check(List<SettingsChange.Edit> edits, boolean all) {
        return service.check(edits, all);
    }

    @Override
    public List<HistoryEntry> history(int limit) {
        return service.history(limit);
    }

    @Override
    public List<SettingsChange.Edit> revert(long id) {
        return service.revert(id);
    }

    @Override
    public String where() {
        return "files";
    }
}
