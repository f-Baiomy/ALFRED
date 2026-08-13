package com.fathy.alfred.backend.database;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.profiles.application.port.out.ProfileStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.settings.application.port.out.FilterSettingsStorePort;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Backs the Settings page's Database tab: storage size/row-count per slice, a call-status
 * breakdown, and the two "clear all" actions. Lives in backend-app (the composition root), not in
 * any one slice, because it needs to read from all five at once - exactly the same reason
 * CommentCallIdMigration lives here (see its class doc): no slice may depend on another
 * (HexagonalArchitectureTest), so only the composition root is allowed to know about all of them.
 */
@RestController
public class DatabaseStatsController {

    private final CallLogPort callLogPort;
    private final CallNotificationPort callNotificationPort;
    private final SessionCycleMetadataStorePort sessionCycleMetadataStorePort;
    private final CapturedCallsStorePort capturedCallsStorePort;
    private final SessionCycleNotificationPort sessionCycleNotificationPort;
    private final ProfileStorePort profileStorePort;
    private final CommentsStorePort commentsStorePort;
    private final FilterSettingsStorePort filterSettingsStorePort;

    public DatabaseStatsController(
            CallLogPort callLogPort,
            CallNotificationPort callNotificationPort,
            SessionCycleMetadataStorePort sessionCycleMetadataStorePort,
            CapturedCallsStorePort capturedCallsStorePort,
            SessionCycleNotificationPort sessionCycleNotificationPort,
            ProfileStorePort profileStorePort,
            CommentsStorePort commentsStorePort,
            FilterSettingsStorePort filterSettingsStorePort
    ) {
        this.callLogPort = callLogPort;
        this.callNotificationPort = callNotificationPort;
        this.sessionCycleMetadataStorePort = sessionCycleMetadataStorePort;
        this.capturedCallsStorePort = capturedCallsStorePort;
        this.sessionCycleNotificationPort = sessionCycleNotificationPort;
        this.profileStorePort = profileStorePort;
        this.commentsStorePort = commentsStorePort;
        this.filterSettingsStorePort = filterSettingsStorePort;
    }

    @GetMapping("/database/stats")
    public DatabaseStatsResponse getStats() {
        long cycleCount = sessionCycleMetadataStorePort.findAll().size();
        long capturedCallCount = capturedCallsStorePort.countAll();
        var filterSettings = filterSettingsStorePort.load();
        long filterRuleCount = 1L + filterSettings.whitelist().size() + filterSettings.blacklist().size();

        List<DatabaseFileStats> files = List.of(
                new DatabaseFileStats("calls.db", callLogPort.statusBreakdown().total(), callLogPort.storageSizeBytes()),
                new DatabaseFileStats("session-cycles.db", cycleCount + capturedCallCount, capturedCallsStorePort.storageSizeBytes()),
                new DatabaseFileStats("profiles.db", profileStorePort.findAll().size(), profileStorePort.storageSizeBytes()),
                new DatabaseFileStats("comments.db", commentsStorePort.findAll().size(), commentsStorePort.storageSizeBytes()),
                new DatabaseFileStats("settings.db", filterRuleCount, filterSettingsStorePort.storageSizeBytes())
        );

        return new DatabaseStatsResponse(callLogPort.statusBreakdown(), files);
    }

    /** Permanently deletes every logged call. Irreversible - the frontend confirms before calling this. */
    @PostMapping("/database/clear-calls")
    public void clearCalls() {
        callLogPort.deleteAll();
        callNotificationPort.notifyCallsCleared();
    }

    /** Permanently deletes every session cycle and every captured call in it. Irreversible - the frontend confirms before calling this. */
    @PostMapping("/database/clear-cycles")
    public void clearCycles() {
        capturedCallsStorePort.deleteAll();
        sessionCycleMetadataStorePort.deleteAll();
        sessionCycleNotificationPort.notifySessionCyclesChanged();
    }
}
