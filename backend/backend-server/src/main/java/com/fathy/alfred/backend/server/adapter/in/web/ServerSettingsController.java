package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.adapter.in.web.dto.SettingsDtos;
import com.fathy.alfred.backend.server.application.port.in.CheckSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.PreviewSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SettingsHistoryUseCase;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import java.util.List;
import java.util.Map;

/**
 * The Server section's settings (contracts/server-api.md). Writes are guarded by {@link EditAccessInterceptor}; this
 * controller only maps the wire shapes. A save from "alfred config" carries X-Alfred-Cli-User, which is recorded as a
 * CLI change - trusted only from this machine (the CLI calls 127.0.0.1), otherwise it is a UI change from the client's
 * address.
 */
@RestController
@RequestMapping("/server")
public class ServerSettingsController {

    static final String CLI_USER_HEADER = "X-Alfred-Cli-User";

    private final GetSettingsUseCase getSettings;
    private final PreviewSettingsUseCase previewSettings;
    private final SaveSettingsUseCase saveSettings;
    private final EditAccessUseCase editAccess;
    private final CheckSettingsUseCase checkSettings;
    private final SettingsHistoryUseCase history;

    public ServerSettingsController(GetSettingsUseCase getSettings, PreviewSettingsUseCase previewSettings,
                                    SaveSettingsUseCase saveSettings, EditAccessUseCase editAccess,
                                    CheckSettingsUseCase checkSettings, SettingsHistoryUseCase history) {
        this.getSettings = getSettings;
        this.previewSettings = previewSettings;
        this.saveSettings = saveSettings;
        this.editAccess = editAccess;
        this.checkSettings = checkSettings;
        this.history = history;
    }

    public record CheckRequest(@Size(max = SettingsDtos.MAX_EDITS) List<SettingsDtos.@Valid EditDto> edits, boolean all) {
    }

    @PostMapping("/settings/check")
    public Map<String, Object> check(@Valid @RequestBody CheckRequest body) {
        List<SettingsChange.Edit> edits = body.edits() == null ? List.of() : body.edits().stream().map(SettingsDtos.EditDto::toDomain).toList();
        return Map.of("results", checkSettings.check(edits, body.all()));
    }

    @GetMapping("/settings/history")
    public List<HistoryEntry> history(@RequestParam(defaultValue = "50") int limit) {
        return history.history(limit);
    }

    @PostMapping("/settings/history/{id}/revert")
    public Map<String, Object> revert(@PathVariable long id) {
        return Map.of("edits", history.revert(id));
    }

    @GetMapping("/access")
    public EditAccess access(HttpServletRequest request) {
        return EditAccessInterceptor.check(request, editAccess);
    }

    @GetMapping("/settings")
    public SettingsDtos.SettingsResponse settings() {
        return SettingsDtos.SettingsResponse.of(getSettings.settings());
    }

    @PostMapping("/settings/preview")
    public PreviewSettingsUseCase.Preview preview(@Valid @RequestBody SettingsDtos.SaveRequest body) {
        return previewSettings.preview(body.toDomain());
    }

    @PutMapping("/settings")
    public SaveSettingsUseCase.Saved save(@Valid @RequestBody SettingsDtos.SaveRequest body, HttpServletRequest request) {
        Source source = source(request);
        return saveSettings.save(body.toDomain(), source.kind, source.detail);
    }

    @PostMapping("/settings/add-missing")
    public SaveSettingsUseCase.Saved addMissing(HttpServletRequest request) {
        Source source = source(request);
        return saveSettings.addMissing(source.kind, source.detail);
    }

    private record Source(HistoryEntry.HistorySource kind, String detail) {
    }

    static Source source(HttpServletRequest request) {
        String cliUser = request.getHeader(CLI_USER_HEADER);
        String peer = request.getRemoteAddr();
        boolean loopback = peer != null && (peer.startsWith("127.") || peer.equals("::1") || peer.equals("0:0:0:0:0:0:0:1"));
        if (cliUser != null && !cliUser.isBlank() && loopback) {
            String user = cliUser.replaceAll("[^A-Za-z0-9._@\\\\-]", "");
            return new Source(HistoryEntry.HistorySource.CLI, user.substring(0, Math.min(64, user.length())));
        }
        return new Source(HistoryEntry.HistorySource.UI, peer);
    }
}
