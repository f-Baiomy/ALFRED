package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Session-cycle calls keep their log lines (specs/008-logs-call-link FR-005a): when a cycle's contents change (calls
 * copied, imported, a recording stopped) its inbound calls' live lines are copied into Alfred's own store, off the
 * request thread; when cycles change, kept lines of calls no cycle holds any more are dropped. Logs only ids and counts.
 */
@Component
public class CycleLogsKeeper {

    private static final Logger log = LoggerFactory.getLogger(CycleLogsKeeper.class);
    private static final int PAGE = 500;
    private static final int SWEEP_LIMIT = 50_000;

    private final CallLogsService callLogs;
    private final ListSessionCyclesUseCase cycles;
    private final ListCapturedInternalCallsUseCase cycleCalls;
    /** Each cycle's status at the last sweep (only the worker thread reads and writes it). */
    private Map<String, SessionCycleStatus> lastStatus = new HashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "cycle-logs-keeper");
        t.setDaemon(true);
        return t;
    });

    public CycleLogsKeeper(CallLogsService callLogs, ListSessionCyclesUseCase cycles, ListCapturedInternalCallsUseCase cycleCalls) {
        this.callLogs = callLogs;
        this.cycles = cycles;
        this.cycleCalls = cycleCalls;
    }

    /**
     * Notes every cycle's status once the application is up, so a recording that was already running at start-up
     * is seen to stop - without it, the first sweep after a restart has nothing to compare with and keeps nothing.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void started() {
        worker.submit(() -> run(this::noteStatuses));
    }

    void noteStatuses() {
        Map<String, SessionCycleStatus> now = new HashMap<>();
        for (SessionCycle c : cycles.listAll()) {
            now.put(c.id(), c.status());
        }
        lastStatus = now;
    }

    /** A cycle's contents changed: keep its calls' lines. */
    public void cycleChanged(String cycleId) {
        worker.submit(() -> run(() -> keepCycle(cycleId)));
    }

    /** The cycle list changed (one deleted, a recording stopped): keep for every cycle's new calls, drop the orphans. */
    public void cyclesChanged() {
        worker.submit(() -> run(this::sweep));
    }

    int keepCycle(String cycleId) {
        int kept = 0;
        List<String> ids = callIds(cycleId);
        for (String id : ids) {
            kept += callLogs.keepForCycle(id, cycleId);
        }
        log.debug("cycle {}: {} log lines kept for {} calls", cycleId, kept, ids.size());
        return kept;
    }

    /** Keeps the lines of a cycle whose recording just stopped or paused; removes kept lines of calls nothing holds any more. */
    int sweep() {
        Set<String> held = new HashSet<>();
        Map<String, SessionCycleStatus> now = new HashMap<>();
        for (SessionCycle c : cycles.listAll()) {
            held.addAll(callIds(c.id()));
            now.put(c.id(), c.status());
            if (lastStatus.get(c.id()) == SessionCycleStatus.RECORDING && c.status() != SessionCycleStatus.RECORDING) {
                keepCycle(c.id()); // live capture sends no content signal: the recording's calls are kept when it stops
            }
        }
        lastStatus = now;
        List<String> orphans = new ArrayList<>(callLogs.callsWithKept(KeptLogLine.Origin.CYCLE, SWEEP_LIMIT));
        orphans.removeAll(held);
        int removed = callLogs.forget(orphans, KeptLogLine.Origin.CYCLE);
        // an imported call's lines go with the call: once no cycle holds it and it is not a live call either (FR-016)
        List<String> imported = new ArrayList<>(callLogs.callsWithKept(KeptLogLine.Origin.IMPORT, SWEEP_LIMIT));
        imported.removeAll(held);
        imported.removeIf(callLogs::isLiveCall);
        removed += callLogs.forget(imported, KeptLogLine.Origin.IMPORT);
        if (removed > 0) {
            log.debug("kept log lines of {} calls in no cycle removed ({} lines)", orphans.size(), removed);
        }
        return removed;
    }

    private List<String> callIds(String cycleId) {
        List<String> ids = new ArrayList<>();
        int offset = 0;
        while (true) {
            var page = cycleCalls.listCalls(cycleId, new CallsQuery("", "", "oldest", offset, PAGE, "", "", "", "", ""));
            if (page.isEmpty() || page.get().calls().isEmpty()) {
                return ids;
            }
            page.get().calls().forEach(captured -> ids.add(captured.call().id()));
            offset += page.get().calls().size();
            if (offset >= page.get().total()) {
                return ids;
            }
        }
    }

    private static void run(Runnable work) {
        try {
            work.run();
        } catch (RuntimeException e) {
            log.warn("keeping cycle log lines failed: {}", e.toString());
        }
    }

    @PreDestroy
    void stop() {
        worker.shutdownNow();
    }
}
