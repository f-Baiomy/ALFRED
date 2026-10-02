package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.out.LeaseQuery;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Tracks which /ws/relive session(s) hold which run's lease (research D1). Event-driven, not
 * polling: {@link #onSessionClosed} only ever fires from the WebSocket handler's own
 * afterConnectionClosed, relayed through backend-app's {@code ReliveLeaseBridge} - this class
 * itself never depends on adapter.out.websocket (ArchUnit's applicationMustNotDependOnAdapter),
 * so it exposes plain methods with the same signatures as adapter.out.websocket.LeaseListener
 * rather than implementing that interface directly. 15s after a run's last holder disconnects
 * with no reconnect, {@link ReliveRunsService#interrupt} runs the same STOPPING-drain path as
 * stop/finish (T046) - it never unpublishes the snapshot in the same step it marks the run
 * INTERRUPTED.
 */
@Service
public class RunLeaseRegistry implements LeaseQuery {

    static final long INTERRUPT_DELAY_MS = 15_000;

    private final ReliveRunsService runsService;
    private final ReliveRunStorePort runStore;
    private final ScheduledExecutorService scheduler;

    private final Map<String, Set<String>> holdersByRunId = new ConcurrentHashMap<>();
    private final Map<String, ScheduledFuture<?>> interruptTimers = new ConcurrentHashMap<>();

    public RunLeaseRegistry(ReliveRunsService runsService, ReliveRunStorePort runStore,
                             ScheduledExecutorService scheduler) {
        this.runsService = runsService;
        this.runStore = runStore;
        this.scheduler = scheduler;
    }

    @Override
    public boolean hasActiveLease(String runId) {
        return !holdersByRunId.getOrDefault(runId, Set.of()).isEmpty();
    }

    public void onLeaseHeld(String runId, String sessionId) {
        holdersByRunId.computeIfAbsent(runId, k -> ConcurrentHashMap.newKeySet()).add(sessionId);
        ScheduledFuture<?> pending = interruptTimers.remove(runId);
        if (pending != null) {
            pending.cancel(false);
        }
    }

    /** A deliberate release. While the run is still RUNNING this is the same as the tab going away. */
    public void onLeaseReleased(String runId, String sessionId) {
        Set<String> holders = holdersByRunId.get(runId);
        if (holders != null && holders.remove(sessionId) && holders.isEmpty()) {
            holdersByRunId.remove(runId);
            scheduleInterrupt(runId);
        }
    }

    @Override
    public void forget(String runId) {
        holdersByRunId.remove(runId);
        ScheduledFuture<?> pending = interruptTimers.remove(runId);
        if (pending != null) {
            pending.cancel(false);
        }
    }

    public void onSessionClosed(String sessionId) {
        for (Map.Entry<String, Set<String>> entry : holdersByRunId.entrySet()) {
            if (entry.getValue().remove(sessionId) && entry.getValue().isEmpty()) {
                scheduleInterrupt(entry.getKey());
            }
        }
    }

    private void scheduleInterrupt(String runId) {
        ScheduledFuture<?> future = scheduler.schedule(() -> {
            interruptTimers.remove(runId);
            runsService.interrupt(runId);
        }, INTERRUPT_DELAY_MS, TimeUnit.MILLISECONDS);
        ScheduledFuture<?> previous = interruptTimers.put(runId, future);
        if (previous != null) {
            previous.cancel(false);
        }
    }

    /** Every run left RUNNING across a restart never had the chance to reach a final status -
     *  interrupt() re-runs the exact STOPPING-drain path so its snapshot is republished (blocking
     *  in-flight calls) and removed 30s later, the same as any other interrupt (T046).
     *
     *  <p>Once the context is ready, not in @PostConstruct: interrupting a run forgets its lease
     *  through the LeaseQuery that is this very bean, and asking for it while it was still being
     *  created failed the whole backend start with a dependency cycle - whenever a run had been
     *  left RUNNING (T082). */
    @EventListener(ContextRefreshedEvent.class)
    void sweepRunningOnStartup() {
        runStore.findAllRunning().forEach(run -> runsService.interrupt(run.id()));
    }
}
