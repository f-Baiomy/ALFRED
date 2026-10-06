package com.fathy.alfred.backend.dbcapture.application.service;

import com.fathy.alfred.backend.dbcapture.application.port.out.CallSignalsObserverPort;
import com.fathy.alfred.backend.dbcapture.application.port.out.DbCaptureStorePort;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlagType;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hands a call's signals - log error/warning/exception counts, the level it was caught at, its database flags - to
 * whoever keeps them (triage, through backend-app). Read from the store, so a caller only says which calls changed.
 * Re-flagging a whole project after its thresholds changed runs here on one background thread, 500 calls at a time.
 */
@Component
public class CallSignalsPublisher implements com.fathy.alfred.backend.dbcapture.application.port.in.RepublishCallSignalsUseCase {

    private static final Logger log = LoggerFactory.getLogger(CallSignalsPublisher.class);
    static final int BATCH = 500;
    /** Failures are triage's own counts (failed/swallowed statements); every other flag is a database warning (FR-022). */
    private static final Set<DbFlagType> NOT_WARNINGS = Set.of(DbFlagType.FAILED, DbFlagType.FAILED_SWALLOWED);

    private final DbCaptureStorePort store;
    private final List<CallSignalsObserverPort> observers;
    private final ExecutorService background = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "db-capture-signals");
        t.setDaemon(true);
        return t;
    });

    public CallSignalsPublisher(DbCaptureStorePort store, List<CallSignalsObserverPort> observers) {
        this.store = store;
        this.observers = observers;
    }

    public void publish(Collection<String> callIds) {
        if (observers.isEmpty() || callIds == null || callIds.isEmpty()) {
            return;
        }
        List<String> ids = callIds.stream().filter(Objects::nonNull).distinct().toList();
        Map<String, CaughtLogCounts> counts = store.logCounts(ids);
        for (String callId : ids) {
            CaughtLogCounts c = counts.get(callId);
            List<String> flags = store.summary(callId).map(CallDbSummary::flags).orElse(List.of()).stream()
                    .map(DbFlag::type).filter(t -> !NOT_WARNINGS.contains(t)).map(Enum::name).distinct().toList();
            String status = c != null || store.catchesLogs(callId) ? "CAUGHT" : null;
            String level = store.callLogLevel(callId).orElse(null);
            for (CallSignalsObserverPort observer : observers) {
                observer.signalsChanged(callId, c == null ? 0 : c.errors(), c == null ? 0 : c.warnings(), c == null ? 0 : c.exceptions(),
                        status, level, flags);
            }
        }
    }

    @Override
    public int republishAll() {
        int n = 0;
        String after = "";
        while (true) {
            List<String> ids = store.callIdsWithSignals(after, BATCH);
            if (ids.isEmpty()) {
                return n;
            }
            publish(ids);
            n += ids.size();
            after = ids.get(ids.size() - 1);
        }
    }

    /** A project's thresholds or expected statements changed: flag its calls again and hand on what changed, in the background. */
    public void reflagProject(String project) {
        if (project == null) {
            return;
        }
        background.submit(() -> reflagNow(project));
    }

    void reflagNow(String project) {
        try {
            long after = 0;
            while (true) {
                List<String> ids = store.callIdsOfProject(project, after, BATCH);
                if (ids.isEmpty()) {
                    return;
                }
                ids.forEach(id -> DbCaptureFlagsListener.reflag(store, id));
                publish(ids);
                after = store.summaryRowId(ids.get(ids.size() - 1));
            }
        } catch (RuntimeException e) {
            log.warn("Re-flagging calls of {} after its settings changed stopped: {}", project, e.getMessage());
        }
    }
}
