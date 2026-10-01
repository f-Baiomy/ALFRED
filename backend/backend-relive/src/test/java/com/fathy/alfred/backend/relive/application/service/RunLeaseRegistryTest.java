package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LeaseQuery;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.Delayed;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class RunLeaseRegistryTest {

    private FakeRunStore runStore;
    private FakePublisher publisher;
    private FakeScheduler scheduler;
    private ReliveRunsService runsService;
    private RunLeaseRegistry registry;

    @BeforeEach
    void setUp() {
        ObjectMapper objectMapper = new ObjectMapper();
        FakeCycleStore cycleStore = new FakeCycleStore();
        runStore = new FakeRunStore();
        publisher = new FakePublisher();
        scheduler = new FakeScheduler();
        RunSnapshotBuilder snapshotBuilder = new RunSnapshotBuilder(publisher, objectMapper);
        ValidateCycleUseCase validator = cycleId -> List.<ValidationFinding>of();
        ReliveNotificationPort notifications = new ReliveNotificationPort() {
            @Override public void cycleChanged() { }
            @Override public void runChanged(String cycleId, String runId) { }
            @Override public void runCall(JsonNode eventJson) { }
        };
        LeaseQuery neverHeld = runId -> false;
        LiveCallStorePort liveCallStore = new LiveCallStorePort() {
            @Override public LiveCall add(LiveCall call) { return call; }
            @Override public List<LiveCall> list(String cycleId, int limit) { return List.of(); }
            @Override public Optional<LiveCall> findById(String id) { return Optional.empty(); }
            @Override public boolean deleteById(String id) { return false; }
            @Override public void deleteByRunIds(java.util.Collection<String> runIds) { }
            @Override public long totalBytes(String cycleId) { return 0L; }
        };
        com.fathy.alfred.backend.relive.application.port.out.RelatedCallsPort relatedCalls = runIds -> 0;
        runsService = new ReliveRunsService(runStore, cycleStore, publisher, notifications, validator,
                snapshotBuilder, neverHeld, scheduler, liveCallStore, relatedCalls, Runnable::run);
        registry = new RunLeaseRegistry(runsService, runStore, scheduler);
    }

    private ReliveCycle cycle(String id, boolean isTransient) {
        return new ReliveCycle(id, "c", null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", isTransient, null);
    }

    private Run runningRun(String id, String cycleId) {
        return new Run(id, cycleId, "AUTOMATIC", RunStatus.RUNNING, "t0", null, cycle(cycleId, false), null,
                List.of(), List.of(), null, null, List.of(), List.of());
    }

    @Test
    void interruptsAfter15sWithNoReconnect() {
        Run run = runningRun("r-1", "c-1");
        runStore.byId.put(run.id(), run);
        registry.onLeaseHeld("r-1", "session-a");

        registry.onSessionClosed("session-a");

        assertThat(scheduler.tasks).hasSize(1);
        assertThat(scheduler.tasks.get(0).delay).isEqualTo(RunLeaseRegistry.INTERRUPT_DELAY_MS);

        scheduler.tasks.get(0).runnable.run();

        assertThat(runStore.findById("r-1").orElseThrow().status()).isEqualTo(RunStatus.INTERRUPTED);
    }

    @Test
    void reconnectBeforeTimeoutCancelsTheInterrupt() {
        Run run = runningRun("r-1", "c-1");
        runStore.byId.put(run.id(), run);
        registry.onLeaseHeld("r-1", "session-a");
        registry.onSessionClosed("session-a");

        registry.onLeaseHeld("r-1", "session-b");

        assertThat(scheduler.tasks.get(0).cancelled).isTrue();
        assertThat(registry.hasActiveLease("r-1")).isTrue();
    }

    @Test
    void startupSweepInterruptsEveryRunningRunAndRepublishesAsStopping() {
        Run run = runningRun("r-1", "c-1");
        runStore.byId.put(run.id(), run);

        registry.sweepRunningOnStartup();

        assertThat(runStore.findById("r-1").orElseThrow().status()).isEqualTo(RunStatus.INTERRUPTED);
        assertThat(publisher.published.get("r-1").get("state").asText()).isEqualTo("STOPPING");
        assertThat(publisher.unpublished).doesNotContain("r-1");
    }

    static class FakeCycleStore implements ReliveCycleStorePort {
        final Map<String, ReliveCycle> byId = new LinkedHashMap<>();
        @Override public List<ReliveCycleSummary> listSummaries() { return List.of(); }
        @Override public Optional<ReliveCycle> findById(String id) { return Optional.ofNullable(byId.get(id)); }
        @Override public boolean existsById(String id) { return byId.containsKey(id); }
        @Override public ReliveCycle save(ReliveCycle cycle) { byId.put(cycle.id(), cycle); return cycle; }
        @Override public boolean deleteById(String id) { return byId.remove(id) != null; }
        @Override public void saveVersion(CycleVersion version, int keep) { }
        @Override public List<CycleVersion> listVersions(String cycleId) { return List.of(); }
        @Override public Optional<CycleVersion> getVersion(String cycleId, int version) { return Optional.empty(); }
        @Override public void pruneVersions(String cycleId, int keep) { }
    }

    static class FakeRunStore implements ReliveRunStorePort {
        final Map<String, Run> byId = new LinkedHashMap<>();
        final List<StepResult> stepResults = new ArrayList<>();
        @Override public Run create(Run run) { byId.put(run.id(), run); return run; }
        @Override public Optional<Run> findById(String runId) { return Optional.ofNullable(byId.get(runId)); }
        @Override public List<Run> listByCycleId(String cycleId, int limit) {
            return byId.values().stream().filter(r -> r.cycleId().equals(cycleId)).toList();
        }
        @Override public List<Run> findAllRunning() {
            return byId.values().stream().filter(r -> r.status() == RunStatus.RUNNING).toList();
        }
        @Override public Run update(Run run) { byId.put(run.id(), run); return run; }
        @Override public void putStepResult(StepResult result) { stepResults.add(result); }
        @Override public List<StepResult> listStepResults(String runId) {
            return stepResults.stream().filter(r -> r.runId().equals(runId)).toList();
        }
        @Override public void pruneRuns(String cycleId, int keep, long maxBytes) { }
        @Override public void deleteByCycleId(String cycleId) { byId.values().removeIf(r -> r.cycleId().equals(cycleId)); }
        @Override public void deleteByIds(java.util.Collection<String> runIds) { byId.keySet().removeAll(runIds); }
    }

    static class FakePublisher implements RunSnapshotPublisherPort {
        final Map<String, JsonNode> published = new LinkedHashMap<>();
        final List<String> unpublished = new ArrayList<>();
        @Override public void publish(String runId, JsonNode snapshotJson) { published.put(runId, snapshotJson); }
        @Override public void unpublish(String runId) { unpublished.add(runId); published.remove(runId); }
        @Override public void publishInflight(JsonNode inflightJson) { }
        @Override public void clearInflight() { }
        @Override public void writeAnswer(String runId, String answerId, JsonNode meta, byte[] body) { }
    }

    static class FakeScheduler implements ScheduledExecutorService {
        final List<Task> tasks = new ArrayList<>();

        static class Task {
            final Runnable runnable;
            final long delay;
            boolean cancelled;
            Task(Runnable runnable, long delay) { this.runnable = runnable; this.delay = delay; }
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            Task task = new Task(command, delay);
            tasks.add(task);
            return new ScheduledFuture<Object>() {
                @Override public long getDelay(TimeUnit unit) { return task.delay; }
                @Override public int compareTo(Delayed o) { return 0; }
                @Override public boolean cancel(boolean mayInterruptIfRunning) { task.cancelled = true; return true; }
                @Override public boolean isCancelled() { return task.cancelled; }
                @Override public boolean isDone() { return false; }
                @Override public Object get() { return null; }
                @Override public Object get(long timeout, TimeUnit unit) { return null; }
            };
        }

        @Override public ScheduledFuture<?> scheduleAtFixedRate(Runnable command, long initialDelay, long period, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command, long initialDelay, long delay, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public <V> ScheduledFuture<V> schedule(Callable<V> callable, long delay, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public void shutdown() { }
        @Override public List<Runnable> shutdownNow() { return List.of(); }
        @Override public boolean isShutdown() { return false; }
        @Override public boolean isTerminated() { return false; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
        @Override public <T> Future<T> submit(Callable<T> task) { throw new UnsupportedOperationException(); }
        @Override public <T> Future<T> submit(Runnable task, T result) { throw new UnsupportedOperationException(); }
        @Override public Future<?> submit(Runnable task) { throw new UnsupportedOperationException(); }
        @Override public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks) { throw new UnsupportedOperationException(); }
        @Override public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks, long timeout, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public <T> T invokeAny(Collection<? extends Callable<T>> tasks) { throw new UnsupportedOperationException(); }
        @Override public <T> T invokeAny(Collection<? extends Callable<T>> tasks, long timeout, TimeUnit unit) { throw new UnsupportedOperationException(); }
        @Override public void execute(Runnable command) { throw new UnsupportedOperationException(); }
    }
}
