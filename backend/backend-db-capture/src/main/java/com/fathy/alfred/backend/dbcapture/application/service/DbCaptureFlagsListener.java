package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.domain.StatementFlags;
import org.springframework.stereotype.Component;

/**
 * Recomputes a call's flags whenever its statements change (a batch arrived, the call completed and failures were
 * marked swallowed). Settings come from the call's project - recorded from the agent that reported its statements -
 * so thresholds and "expected" apply per project.
 */
@Component
public class DbCaptureFlagsListener implements IngestListener {

    /** Flags read whole calls; a call past this many statements is flagged on its first part only. */
    static final int MAX_STATEMENTS = 20_000;
    static final String UNKNOWN_PROJECT = "unknown";

    private final DbCaptureStorePort store;

    public DbCaptureFlagsListener(DbCaptureStorePort store) {
        this.store = store;
    }

    @Override
    public void callIngested(String callId) {
        reflag(store, callId);
    }

    /** Flags the call again from its stored statements, with its project's current settings. */
    static void reflag(DbCaptureStorePort store, String callId) {
        if (store.summary(callId).isEmpty()) {
            return;
        }
        var statements = store.allStatements(callId, MAX_STATEMENTS);
        var settings = store.settings(store.callProject(callId).orElse(UNKNOWN_PROJECT));
        store.saveFlags(callId, StatementFlags.compute(statements, store.transactions(callId), store.markers(callId), settings));
    }
}
