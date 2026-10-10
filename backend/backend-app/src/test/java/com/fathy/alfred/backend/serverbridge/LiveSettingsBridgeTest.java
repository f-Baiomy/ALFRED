package com.fathy.alfred.backend.serverbridge;

import com.fathy.alfred.backend.calls.application.port.in.SetStorageBudgetUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.SetCaptureBudgetUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReloadProjectsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.SetRetentionUseCase;
import com.fathy.alfred.backend.logs.application.port.in.WatchFoldersUseCase;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

class LiveSettingsBridgeTest {

    private final SetRetentionUseCase retention = mock(SetRetentionUseCase.class);
    private final ReloadProjectsUseCase projects = mock(ReloadProjectsUseCase.class);
    private final SetStorageBudgetUseCase calls = mock(SetStorageBudgetUseCase.class);
    private final SetCaptureBudgetUseCase capture = mock(SetCaptureBudgetUseCase.class);
    private final WatchFoldersUseCase folders = mock(WatchFoldersUseCase.class);
    private final LiveSettingsBridge bridge = new LiveSettingsBridge(retention, projects, calls, capture, folders);

    @Test
    void eachLiveSettingReachesItsOwningSlice() {
        Map<String, String> effective = Map.of(
                "INTERNAL_CALLS_RETENTION_ROWS", "5000",
                "ALFRED_CALLS_MAX_SIZE_BYTES", "2147483648",
                "INTERNAL_CALLS_MAX_SIZE_BYTES", "3221225472",
                "ALFRED_DB_CAPTURE_MAX_SIZE_BYTES", "4294967296",
                "ALFRED_REDIS_CAPTURE_MAX_SIZE_BYTES", "1073741824",
                "ALFRED_LOGS_WATCH_DIRS", "app:/var/log/app",
                "INTERNAL_CALL_SERVICES", "a:9001:8080",
                "REVERSE_PROXY_ENABLED", "true");
        effective.keySet().forEach(key -> bridge.apply(key, effective));

        verify(retention).setRetentionRows(5000);
        verify(calls).setMaxSizeBytes(2147483648L);
        verify(retention).setMaxSizeBytes(3221225472L);
        verify(capture).setStatementsMaxBytes(4294967296L);
        verify(capture).setRedisMaxBytes(1073741824L);
        verify(folders).replaceFolders("app:/var/log/app");
        verify(projects, org.mockito.Mockito.times(2)).reload("a:9001:8080", true);
    }

    @Test
    void restartSettingsAreRefusedSoTheyStayPending() {
        assertThatThrownBy(() -> bridge.apply("ALFRED_MEMORY", Map.of("ALFRED_MEMORY", "3g")))
                .isInstanceOf(IllegalArgumentException.class);
        bridge.apply("ALFRED_SETTINGS_EDIT_FROM", Map.of());
        verifyNoInteractions(retention, projects, calls, capture, folders);
    }
}
