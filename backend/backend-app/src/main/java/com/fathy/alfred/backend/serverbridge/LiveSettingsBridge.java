package com.fathy.alfred.backend.serverbridge;

import com.fathy.alfred.backend.calls.application.port.in.SetStorageBudgetUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.SetCaptureBudgetUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReloadProjectsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.SetRetentionUseCase;
import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import com.fathy.alfred.backend.server.application.port.out.LiveSettingsPort;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Where a saved server setting takes effect without a restart (specs/012-server-program research R8): the owning
 * slice's runtime setter. Lives in the composition root so backend-server never depends on the slices it configures
 * (no new cross-slice edge - Constitution III).
 */
@Component
public class LiveSettingsBridge implements LiveSettingsPort {

    private final SetRetentionUseCase retention;
    private final ReloadProjectsUseCase projects;
    private final SetStorageBudgetUseCase callsBudget;
    private final SetCaptureBudgetUseCase captureBudget;
    private final WatchFoldersUseCase watchFolders;

    public LiveSettingsBridge(SetRetentionUseCase retention, ReloadProjectsUseCase projects, SetStorageBudgetUseCase callsBudget,
                              SetCaptureBudgetUseCase captureBudget, WatchFoldersUseCase watchFolders) {
        this.retention = retention;
        this.projects = projects;
        this.callsBudget = callsBudget;
        this.captureBudget = captureBudget;
        this.watchFolders = watchFolders;
    }

    @Override
    public void apply(String key, Map<String, String> effective) {
        String value = effective.getOrDefault(key, "");
        switch (key) {
            case "INTERNAL_CALLS_RETENTION_ROWS" -> retention.setRetentionRows(Integer.parseInt(value));
            case "ALFRED_CALLS_MAX_SIZE_BYTES" -> callsBudget.setMaxSizeBytes(Long.parseLong(value));
            case "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES" -> captureBudget.setStatementsMaxBytes(Long.parseLong(value));
            case "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES" -> captureBudget.setRedisMaxBytes(Long.parseLong(value));
            case "ALFRED_LOGS_WATCH_DIRS" -> watchFolders.replaceFolders(value);
            case "INTERNAL_CALL_SERVICES", "REVERSE_PROXY_ENABLED" -> projects.reload(
                    effective.getOrDefault("INTERNAL_CALL_SERVICES", ""),
                    "true".equalsIgnoreCase(effective.getOrDefault("REVERSE_PROXY_ENABLED", "false")));
            // Read on every request by the server slice itself.
            case "ALFRED_SETTINGS_EDIT_FROM" -> { }
            default -> throw new IllegalArgumentException(key + " is applied at the next restart");
        }
    }
}
