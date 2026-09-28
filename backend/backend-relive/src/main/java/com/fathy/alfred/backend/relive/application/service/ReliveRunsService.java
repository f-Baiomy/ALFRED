package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.in.FinishRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.HoldRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RecordStepResultUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ResumeRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RunBlockedException;
import com.fathy.alfred.backend.relive.application.port.in.RunDefinitionConflictException;
import com.fathy.alfred.backend.relive.application.port.in.RunLeaseHeldException;
import com.fathy.alfred.backend.relive.application.port.in.RunNotResumableException;
import com.fathy.alfred.backend.relive.application.port.in.SetRunVariableUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StartRunCommand;
import com.fathy.alfred.backend.relive.application.port.in.StartRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StopRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UpdateRunDefinitionUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LeaseQuery;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.model.Hold;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.LogEntry;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Resumed;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.RunSummary;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepState;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import com.fathy.alfred.backend.relive.domain.model.VariableChange;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Implements the run engine's own use cases (FR-030-034d, 044a). {@code stop}/{@code finish} (and
 * T047's {@code interrupt}) all go through {@link #finalizeRun}, which never unpublishes the proxy
 * snapshot in the same step it settles the run's status - an in-flight inbound step whose REPLAY
 * children aren't answered yet would otherwise get forwarded to the real supplier the instant the
 * snapshot file disappeared. The snapshot is republished as STOPPING (already produced by
 * {@link RunSnapshotBuilder#build} for any non-RUNNING status) and only removed once T050's
 * observer reports the run's in-flight calls drained ({@link #onInflightDrained}) or a fallback
 * timer fires, whichever comes first.
 */
@Service
public class ReliveRunsService implements StartRunUseCase, RecordStepResultUseCase, StopRunUseCase,
        FinishRunUseCase, HoldRunUseCase, ResumeRunUseCase, UpdateRunDefinitionUseCase, ListRunsUseCase,
        GetRunUseCase, SetRunVariableUseCase, ObserveRunCallUseCase {

    /** Mirrors CycleValidator.VARIABLE_TOKEN / frontend/src/app/shared/utils/variable-tokens.ts. */
    private static final Pattern VARIABLE_TOKEN = Pattern.compile("\\{\\{\\$\\.([A-Za-z][A-Za-z0-9_.-]*)}}");

    /** data-model.md "Run" retention: no alfred.relive.runs.* config property exists yet to bind
     *  to (grepped) - these are the documented defaults, literal like ReliveLimits until one is added. */
    private static final int DEFAULT_KEEP_RUNS = 50;
    private static final long DEFAULT_MAX_RUN_BYTES = 500L * 1024 * 1024;

    static final long STOPPING_DRAIN_TIMEOUT_MS = 30_000;

    private final ReliveRunStorePort runStore;
    private final ReliveCycleStorePort cycleStore;
    private final RunSnapshotPublisherPort publisher;
    private final ReliveNotificationPort notifications;
    private final ValidateCycleUseCase validateCycle;
    private final RunSnapshotBuilder snapshotBuilder;
    private final LeaseQuery leaseQuery;
    private final ScheduledExecutorService scheduler;
    private final LiveCallStorePort liveCallStore;
    private final ObjectMapper objectMapper = new ObjectMapper();

    private final Map<String, ScheduledFuture<?>> stoppingTimers = new ConcurrentHashMap<>();
    /** Every run currently RUNNING or STOPPING - drives whether relive/inflight.json exists at all
     *  (T050); a run leaves this set only once its snapshot is actually unpublished. */
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    /** serviceName -> in-flight outbound calls attributed to a run from that project (proxy-snapshot.md's inflight.json). */
    private final Map<String, List<InflightEntry>> inflightByProject = new ConcurrentHashMap<>();

    private record InflightEntry(String callId, String runId, String stepKey) {
    }

    public ReliveRunsService(ReliveRunStorePort runStore, ReliveCycleStorePort cycleStore,
                              RunSnapshotPublisherPort publisher, ReliveNotificationPort notifications,
                              ValidateCycleUseCase validateCycle, RunSnapshotBuilder snapshotBuilder,
                              @Lazy LeaseQuery leaseQuery, ScheduledExecutorService scheduler,
                              LiveCallStorePort liveCallStore) {
        this.runStore = runStore;
        this.cycleStore = cycleStore;
        this.publisher = publisher;
        this.notifications = notifications;
        this.validateCycle = validateCycle;
        this.snapshotBuilder = snapshotBuilder;
        this.leaseQuery = leaseQuery;
        this.scheduler = scheduler;
        this.liveCallStore = liveCallStore;
    }

    @Override
    public Run start(String cycleId, StartRunCommand command) {
        ReliveCycle cycle = cycleStore.findById(cycleId)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + cycleId + " does not exist"));
        List<ValidationFinding> findings = validateCycle.validate(cycleId);
        if (findings.stream().anyMatch(f -> "BLOCK".equals(f.severity()))) {
            throw new RunBlockedException(findings);
        }
        String runId = UUID.randomUUID().toString();
        String now = Instant.now().toString();
        List<VariableChange> seedVariables = command.seedFromRunId() == null ? List.of()
                : runStore.findById(command.seedFromRunId()).map(Run::variableTimeline).orElse(List.of());
        String driver = command.driver() == null ? cycle.settings().defaultDriver() : command.driver();
        Run run = new Run(runId, cycleId, driver, RunStatus.RUNNING, now, null, cycle, command.fromStepKey(),
                seedVariables, seedVariables, computeSummary(cycle, List.of()), null, List.of(), List.of());
        publisher.publish(runId, snapshotBuilder.build(run));
        Run created = runStore.create(run);
        activeRunIds.add(runId);
        refreshInflightPresence();
        notifications.runChanged(cycleId, runId);
        return created;
    }

    @Override
    public void recordStepResult(String runId, StepResult result) {
        runStore.putStepResult(result);
        Run run = getOrThrow(runId);
        runStore.update(withSummary(run, computeSummary(run.definition(), runStore.listStepResults(runId))));
    }

    @Override
    public void setVariable(String runId, String name, String value, String stepKey) {
        Run run = getOrThrow(runId);
        List<VariableChange> timeline = new ArrayList<>(run.variableTimeline());
        timeline.add(new VariableChange(name, value, stepKey, Instant.now().toString()));
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                run.definition(), run.fromStepKey(), run.seedVariables(), timeline, run.summary(), run.hold(),
                run.resumed(), run.log());
        runStore.update(updated);
        if (isReferencedByARule(updated.definition(), name)) {
            publisher.publish(runId, snapshotBuilder.build(updated));
        }
        notifications.runChanged(run.cycleId(), runId);
    }

    @Override
    public Run stop(String runId) {
        return finalizeRun(getOrThrow(runId), RunStatus.STOPPED);
    }

    @Override
    public Run finish(String runId, RunStatus status) {
        return finalizeRun(getOrThrow(runId), status);
    }

    /** T047's RunLeaseRegistry calls this once the last lease holder is gone for 15s - same
     *  drain-safe path as stop/finish, just a different terminal status. */
    public Run interrupt(String runId) {
        return finalizeRun(getOrThrow(runId), RunStatus.INTERRUPTED);
    }

    @Override
    public Run hold(String runId, String stepKey, String reason) {
        Run run = getOrThrow(runId);
        String now = Instant.now().toString();
        Hold newHold = reason == null ? null : new Hold(stepKey, reason, now);
        List<LogEntry> log = new ArrayList<>(run.log());
        log.add(new LogEntry(now, stepKey, reason == null ? "CONTINUED" : "HELD",
                reason == null ? "Continued past hold" : reason));
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                run.definition(), run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                newHold, run.resumed(), log);
        return runStore.update(updated);
    }

    @Override
    public Run resume(String runId, String afterStepKey) {
        Run run = getOrThrow(runId);
        if (run.status() != RunStatus.FAILED && run.status() != RunStatus.STOPPED && run.status() != RunStatus.INTERRUPTED) {
            throw new RunNotResumableException(runId);
        }
        if (leaseQuery.hasActiveLease(runId)) {
            throw new RunLeaseHeldException(runId);
        }
        List<Resumed> resumed = new ArrayList<>(run.resumed());
        resumed.add(new Resumed(Instant.now().toString(), afterStepKey));
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), RunStatus.RUNNING, run.startedAt(), null,
                run.definition(), run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                null, resumed, run.log());
        runStore.update(updated);
        publisher.publish(runId, snapshotBuilder.build(updated));
        notifications.runChanged(run.cycleId(), runId);
        return updated;
    }

    @Override
    public Run updateDefinition(String runId, ReliveCycle definition, String reason) {
        Run run = getOrThrow(runId);
        Set<String> resultKeys = runStore.listStepResults(runId).stream().map(StepResult::stepKey).collect(Collectors.toSet());
        Map<String, Step> incomingByKey = new LinkedHashMap<>();
        definition.steps().forEach(s -> incomingByKey.put(s.key(), s));

        List<Step> mergedSteps = new ArrayList<>();
        for (Step currentStep : run.definition().steps()) {
            Step incoming = incomingByKey.remove(currentStep.key());
            if (incoming == null) {
                mergedSteps.add(currentStep);
                continue;
            }
            boolean hasResult = resultKeys.contains(currentStep.key());
            boolean changed = !incoming.equals(currentStep);
            if (hasResult && changed) {
                throw new RunDefinitionConflictException(runId, currentStep.key());
            }
            mergedSteps.add(hasResult ? currentStep : incoming);
        }
        mergedSteps.addAll(incomingByKey.values()); // brand-new steps added mid-run, never had a result

        ReliveCycle mergedDefinition = new ReliveCycle(run.definition().id(), definition.name(), definition.description(),
                mergedSteps, definition.variables(), definition.cycleRules(), definition.globalRules(),
                definition.settings(), definition.noise(), definition.unexpectedCalls(),
                run.definition().createdAt(), run.definition().updatedAt(), run.definition().isTransient(),
                run.definition().lastRun());
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                mergedDefinition, run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                run.hold(), run.resumed(), run.log());
        runStore.update(updated);
        publisher.publish(runId, snapshotBuilder.build(updated));
        notifications.runChanged(run.cycleId(), runId);
        return updated;
    }

    @Override
    public List<Run> list(String cycleId, int limit) {
        return runStore.listByCycleId(cycleId, limit);
    }

    @Override
    public Optional<RunDetail> get(String runId) {
        return runStore.findById(runId).map(run -> new RunDetail(run, runStore.listStepResults(runId)));
    }

    /** T050's observer calls this once inflight.json has no more entries for a STOPPING run. */
    public void onInflightDrained(String runId) {
        completeDrain(runId);
    }

    private Run finalizeRun(Run run, RunStatus status) {
        cancelRemainingSteps(run);
        Run finalized = new Run(run.id(), run.cycleId(), run.driver(), status, run.startedAt(),
                Instant.now().toString(), run.definition(), run.fromStepKey(), run.seedVariables(),
                run.variableTimeline(), computeSummary(run.definition(), runStore.listStepResults(run.id())),
                null, run.resumed(), run.log());
        runStore.update(finalized);
        // RunSnapshotBuilder.build() already renders "state": "STOPPING" for any non-RUNNING status.
        publisher.publish(run.id(), snapshotBuilder.build(finalized));
        notifications.runChanged(run.cycleId(), run.id());
        scheduleStoppingDrain(run.id());
        runStore.pruneRuns(run.cycleId(), DEFAULT_KEEP_RUNS, DEFAULT_MAX_RUN_BYTES);
        cleanupIfTransient(finalized);
        return finalized;
    }

    private void scheduleStoppingDrain(String runId) {
        ScheduledFuture<?> future = scheduler.schedule(() -> completeDrain(runId), STOPPING_DRAIN_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        stoppingTimers.put(runId, future);
    }

    private void completeDrain(String runId) {
        ScheduledFuture<?> future = stoppingTimers.remove(runId);
        if (future != null) {
            future.cancel(false);
        }
        publisher.unpublish(runId);
        inflightByProject.values().forEach(entries -> entries.removeIf(e -> runId.equals(e.runId())));
        activeRunIds.remove(runId);
        refreshInflightPresence();
    }

    /** FR-003c: checked against the CURRENT stored cycle, not the run's frozen definition snapshot -
     *  a cycle explicitly saved mid-run already has its transient flag cleared by
     *  ManageReliveCyclesUseCase.update, and must be kept even though this run's own definition()
     *  still remembers it as transient. ReliveRunStorePort has no delete-single-run method, so a
     *  transient cycle's entire (throwaway) run history is removed with it. */
    private void cleanupIfTransient(Run run) {
        cycleStore.findById(run.cycleId()).ifPresent(current -> {
            if (current.isTransient()) {
                runStore.deleteByCycleId(run.cycleId());
                cycleStore.deleteById(run.cycleId());
            }
        });
    }

    private void cancelRemainingSteps(Run run) {
        Set<String> resultKeys = runStore.listStepResults(run.id()).stream().map(StepResult::stepKey).collect(Collectors.toSet());
        String now = Instant.now().toString();
        for (Step step : run.definition().steps()) {
            if (!resultKeys.contains(step.key())) {
                runStore.putStepResult(new StepResult(run.id(), step.key(), 1, StepState.CANCELLED,
                        null, null, null, null, null, List.of(), List.of(), List.of(), List.of(), null,
                        now, now, 0L, null, List.of(), null, List.of(), null));
            }
        }
    }

    @Override
    public void onOutboundCallPrepared(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        JsonNode relive = call.relive();
        String runId = runIdOf(relive);
        if (runId == null) {
            return;
        }
        addInflightEntry(call.serviceName(), call.callId(), runId, stepKeyOf(relive));
        broadcastRunCall(call, relive, "outbound", "IN_PROGRESS");
    }

    @Override
    public void onOutboundCallCompleted(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        removeInflightEntry(call.callId());
        JsonNode relive = call.relive();
        if (runIdOf(relive) == null) {
            return;
        }
        broadcastRunCall(call, relive, "outbound", "COMPLETED");
        maybeAddLiveCall(call, relive);
    }

    @Override
    public void onInboundCallCompleted(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        JsonNode relive = call.relive();
        if (runIdOf(relive) == null) {
            return;
        }
        broadcastRunCall(call, relive, "inbound", "COMPLETED");
        maybeAddLiveCall(call, relive);
    }

    private static String runIdOf(JsonNode relive) {
        return relive == null ? null : relive.path("runId").asText(null);
    }

    private static String stepKeyOf(JsonNode relive) {
        return relive == null ? null : relive.path("stepKey").asText(null);
    }

    /** FR-050a: a call the proxy could not attribute to exactly one run is logged against every run it matched. */
    private boolean handleAmbiguousIfPresent(ObservedCall call) {
        JsonNode relive = call.relive();
        if (relive == null || !relive.has("ambiguousRunIds")) {
            return false;
        }
        String now = Instant.now().toString();
        for (JsonNode idNode : relive.get("ambiguousRunIds")) {
            String runId = idNode.asText();
            runStore.findById(runId).ifPresent(run -> {
                List<LogEntry> log = new ArrayList<>(run.log());
                log.add(new LogEntry(now, null, "AMBIGUOUS_BLOCKED",
                        "Call " + call.callId() + " matched more than one active run and was blocked."));
                runStore.update(new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(),
                        run.finishedAt(), run.definition(), run.fromStepKey(), run.seedVariables(),
                        run.variableTimeline(), run.summary(), run.hold(), run.resumed(), log));
                notifications.runChanged(run.cycleId(), run.id());
            });
        }
        return true;
    }

    private void broadcastRunCall(ObservedCall call, JsonNode relive, String direction, String state) {
        ObjectNode event = objectMapper.createObjectNode();
        event.put("type", "run-call");
        event.put("runId", runIdOf(relive));
        event.put("stepKey", stepKeyOf(relive));
        event.put("callId", call.callId());
        event.put("direction", direction);
        event.put("attribution", relive.path("attribution").asText(null));
        event.put("state", state);
        // The Guided driver (T077) has no stepKey for an inbound call until the frontend matches
        // it by endpoint - method/url are the only fields it needs for that.
        event.put("method", call.method());
        event.put("url", call.url());
        notifications.runCall(event);
    }

    /** FR-015b/D18 - only when the call actually reached upstream while attributed to a run; the
     *  underlying decision (why) lives in the proxy's rule evaluation, not observable from here, so
     *  {@code reason} is the relive attribution's own "choice" field verbatim, or a generic fallback. */
    private void maybeAddLiveCall(ObservedCall call, JsonNode relive) {
        if (!call.reachedUpstream()) {
            return;
        }
        String runId = runIdOf(relive);
        if (runId == null) {
            return;
        }
        runStore.findById(runId).ifPresent(run -> {
            String reason = relive.path("choice").asText("REACHED_UPSTREAM");
            LiveCall liveCall = new LiveCall(UUID.randomUUID().toString(), run.cycleId(), runId, stepKeyOf(relive),
                    reason, call.callId(), call.request(), call.response(),
                    call.status() == null ? 0 : call.status(), call.durationMs() == null ? 0L : call.durationMs(),
                    call.at() == null ? Instant.now().toString() : call.at());
            liveCallStore.add(liveCall);
        });
    }

    private void addInflightEntry(String serviceName, String callId, String runId, String stepKey) {
        String project = serviceName == null ? "unknown" : serviceName;
        inflightByProject.computeIfAbsent(project, k -> new CopyOnWriteArrayList<>())
                .add(new InflightEntry(callId, runId, stepKey));
        refreshInflightPresence();
    }

    private void removeInflightEntry(String callId) {
        Set<String> affectedRunIds = new HashSet<>();
        inflightByProject.values().forEach(entries -> entries.removeIf(e -> {
            if (!e.callId().equals(callId)) {
                return false;
            }
            if (e.runId() != null) {
                affectedRunIds.add(e.runId());
            }
            return true;
        }));
        refreshInflightPresence();
        for (String runId : affectedRunIds) {
            boolean stillInFlight = inflightByProject.values().stream().flatMap(List::stream)
                    .anyMatch(e -> runId.equals(e.runId()));
            if (!stillInFlight) {
                // Only a run already past RUNNING is draining - completeDrain would incorrectly
                // unpublish a live run's own snapshot otherwise.
                runStore.findById(runId).ifPresent(run -> {
                    if (run.status() != RunStatus.RUNNING) {
                        onInflightDrained(runId);
                    }
                });
            }
        }
    }

    private void refreshInflightPresence() {
        if (activeRunIds.isEmpty()) {
            publisher.clearInflight();
        } else {
            publisher.publishInflight(buildInflightJson());
        }
    }

    private JsonNode buildInflightJson() {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("at", System.currentTimeMillis());
        ObjectNode projects = root.putObject("projects");
        inflightByProject.forEach((project, entries) -> {
            ArrayNode array = projects.putArray(project);
            entries.forEach(e -> {
                ObjectNode node = array.addObject();
                node.put("callId", e.callId());
                node.put("runId", e.runId());
                node.put("stepKey", e.stepKey());
            });
        });
        return root;
    }

    private RunSummary computeSummary(ReliveCycle definition, List<StepResult> results) {
        Map<String, StepResult> latestByStep = new LinkedHashMap<>();
        for (StepResult r : results) {
            latestByStep.merge(r.stepKey(), r, (a, b) -> b.attempt() >= a.attempt() ? b : a);
        }
        int completed = 0, different = 0, failed = 0, skipped = 0, notCalled = 0, cancelled = 0, live = 0, replayed = 0, unattributed = 0;
        for (StepResult r : latestByStep.values()) {
            switch (r.state()) {
                case COMPLETED -> completed++;
                case COMPLETED_WITH_DIFFERENCES -> different++;
                case FAILED -> failed++;
                case SKIPPED -> skipped++;
                case NOT_CALLED -> notCalled++;
                case CANCELLED -> cancelled++;
                case LIVE -> live++;
                case REPLAYED -> replayed++;
                default -> { }
            }
            if ("UNATTRIBUTED".equals(r.attribution())) {
                unattributed++;
            }
        }
        int total = definition.steps() == null ? 0 : definition.steps().size();
        return new RunSummary(total, completed, different, failed, skipped, notCalled, cancelled, live, replayed, unattributed);
    }

    private Run withSummary(Run run, RunSummary summary) {
        return new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                run.definition(), run.fromStepKey(), run.seedVariables(), run.variableTimeline(), summary,
                run.hold(), run.resumed(), run.log());
    }

    private boolean isReferencedByARule(ReliveCycle definition, String variableName) {
        Set<String> used = new java.util.HashSet<>();
        if (definition.steps() != null) {
            definition.steps().forEach(s -> {
                if (s.callRule() != null) {
                    collectTokens(s.callRule().rule(), used);
                }
            });
        }
        if (definition.cycleRules() != null) {
            definition.cycleRules().forEach(r -> collectTokens(r.rule(), used));
        }
        if (definition.unexpectedCalls() != null && definition.unexpectedCalls().rules() != null) {
            definition.unexpectedCalls().rules().forEach(r -> collectTokens(r.rule(), used));
        }
        return used.contains(variableName);
    }

    private void collectTokens(com.fasterxml.jackson.databind.JsonNode node, Set<String> into) {
        if (node == null) {
            return;
        }
        Matcher matcher = VARIABLE_TOKEN.matcher(node.toString());
        while (matcher.find()) {
            into.add(matcher.group(1));
        }
    }

    private Run getOrThrow(String runId) {
        return runStore.findById(runId).orElseThrow(() -> new IllegalArgumentException("Run " + runId + " does not exist"));
    }
}
