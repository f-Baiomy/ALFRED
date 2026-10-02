package com.fathy.alfred.backend.relive.application.service;

import com.fathy.alfred.backend.relive.application.port.in.FinishRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.GetRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.HoldRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ListRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RecordStepResultUseCase;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryCommand;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ResumeRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RunBlockedException;
import com.fathy.alfred.backend.relive.application.port.in.RunDefinitionConflictException;
import com.fathy.alfred.backend.relive.application.port.in.RunLeaseHeldException;
import com.fathy.alfred.backend.relive.application.port.in.RunNotResumableException;
import com.fathy.alfred.backend.relive.application.port.in.SetRunVariableUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StartRunCommand;
import com.fathy.alfred.backend.relive.application.port.in.StartRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StopRunUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StopRunsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UpdateRunDefinitionUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LeaseQuery;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RelatedCallsPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.model.Hold;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.LogEntry;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveLimits;
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
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
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
        StopRunsUseCase, DeleteRunHistoryUseCase, FinishRunUseCase, HoldRunUseCase, ResumeRunUseCase,
        UpdateRunDefinitionUseCase, ListRunsUseCase, GetRunUseCase, SetRunVariableUseCase,
        ObserveRunCallUseCase {

    private static final Logger log = LoggerFactory.getLogger(ReliveRunsService.class);

    /** Mirrors CycleValidator.VARIABLE_TOKEN / frontend/src/app/shared/utils/variable-tokens.ts. */
    private static final Pattern VARIABLE_TOKEN = Pattern.compile("\\{\\{\\$\\.([A-Za-z][A-Za-z0-9_.-]*)}}");

    /** data-model.md "Run" retention: no alfred.relive.runs.* config property exists yet to bind
     *  to (grepped) - these are the documented defaults, literal like ReliveLimits until one is added. */
    private static final int DEFAULT_KEEP_RUNS = 50;
    private static final long DEFAULT_MAX_RUN_BYTES = 500L * 1024 * 1024;

    static final long STOPPING_DRAIN_TIMEOUT_MS = 30_000;

    /** How long an ended, unsaved quick run stays around for "Save as cycle". */
    static final long TRANSIENT_KEEP_MS = 30L * 60 * 1000;

    private final ReliveRunStorePort runStore;
    private final ReliveCycleStorePort cycleStore;
    private final RunSnapshotPublisherPort publisher;
    private final ReliveNotificationPort notifications;
    private final ValidateCycleUseCase validateCycle;
    private final RunSnapshotBuilder snapshotBuilder;
    private final LeaseQuery leaseQuery;
    private final ScheduledExecutorService scheduler;
    private final LiveCallStorePort liveCallStore;
    private final RelatedCallsPort relatedCalls;
    private final Executor callsCleanupExecutor;
    private final ObjectMapper objectMapper = new ObjectMapper();

    private final Map<String, ScheduledFuture<?>> stoppingTimers = new ConcurrentHashMap<>();
    /** Every run currently RUNNING or STOPPING - drives whether relive/inflight.json exists at all
     *  (T050); a run leaves this set only once its snapshot is actually unpublished. */
    private final Set<String> activeRunIds = ConcurrentHashMap.newKeySet();
    /** serviceName -> in-flight outbound calls attributed to a run from that project (proxy-snapshot.md's inflight.json). */
    private final Map<String, List<InflightEntry>> inflightByProject = new ConcurrentHashMap<>();
    /** One lock per run: every run change is read-modify-write of the whole row, and the proxy,
     *  the observer and the browser write the same run at the same time (review B12). */
    private final Map<String, Object> runLocks = new ConcurrentHashMap<>();

    private Object lockFor(String runId) {
        return runLocks.computeIfAbsent(runId, k -> new Object());
    }

    private record InflightEntry(String callId, String runId, String stepKey) {
    }

    public ReliveRunsService(ReliveRunStorePort runStore, ReliveCycleStorePort cycleStore,
                              RunSnapshotPublisherPort publisher, ReliveNotificationPort notifications,
                              ValidateCycleUseCase validateCycle, RunSnapshotBuilder snapshotBuilder,
                              @Lazy LeaseQuery leaseQuery, ScheduledExecutorService scheduler,
                              LiveCallStorePort liveCallStore, RelatedCallsPort relatedCalls,
                              @Qualifier("reliveCallsCleanupExecutor") Executor callsCleanupExecutor) {
        this.runStore = runStore;
        this.cycleStore = cycleStore;
        this.publisher = publisher;
        this.notifications = notifications;
        this.validateCycle = validateCycle;
        this.snapshotBuilder = snapshotBuilder;
        this.leaseQuery = leaseQuery;
        this.scheduler = scheduler;
        this.liveCallStore = liveCallStore;
        this.relatedCalls = relatedCalls;
        this.callsCleanupExecutor = callsCleanupExecutor;
    }

    @Override
    public Run start(String cycleId, StartRunCommand command) {
        ReliveCycle cycle = cycleStore.findById(cycleId)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + cycleId + " does not exist"));
        List<ValidationFinding> findings = validateCycle.validate(cycleId);
        if (findings.stream().anyMatch(f -> "BLOCK".equals(f.severity()))) {
            throw new RunBlockedException(findings);
        }
        cycle = persistIndexIfAbsent(cycle);
        String runId = UUID.randomUUID().toString();
        String now = Instant.now().toString();
        List<VariableChange> seedVariables = seedFor(cycle, command);
        String driver = command.driver() == null ? cycle.settings().defaultDriver() : command.driver();
        Run run = new Run(runId, cycleId, driver, RunStatus.RUNNING, now, null, cycle, command.fromStepKey(),
                seedVariables, seedVariables, computeSummary(cycle, List.of()), null, List.of(), List.of());
        // Stored first: a snapshot published for a run that then failed to save would apply its
        // REPLAY and BLOCK rules forever, with no row for the startup sweep or a drain to find.
        Run created = runStore.create(run);
        publisher.publish(runId, snapshotBuilder.build(run));
        activeRunIds.add(runId);
        refreshInflightPresence();
        notifications.runChanged(cycleId, runId);
        return created;
    }

    /**
     * FR-036: the variables the seed run had produced BEFORE {@code fromStepKey} - values set by
     * that step or later ones would make the new run start from a state it never had. Values with
     * no step (defined or seeded) always carry over.
     */
    private List<VariableChange> seedFor(ReliveCycle cycle, StartRunCommand command) {
        if (command.seedFromRunId() == null) {
            return List.of();
        }
        Run seed = runStore.findById(command.seedFromRunId())
                .filter(run -> run.cycleId().equals(cycle.id()))
                .orElseThrow(() -> new IllegalArgumentException(
                        "Run " + command.seedFromRunId() + " is not a run of cycle " + cycle.id()));
        Set<String> before = new HashSet<>();
        if (command.fromStepKey() != null) {
            Map<String, String> parentOf = new LinkedHashMap<>();
            cycle.steps().forEach(step -> parentOf.put(step.key(), step.parentKey()));
            List<String> tops = cycle.steps().stream().filter(step -> step.parentKey() == null).map(Step::key).toList();
            int fromIndex = tops.indexOf(command.fromStepKey());
            if (fromIndex < 0) {
                throw new IllegalArgumentException("Step " + command.fromStepKey() + " is not a top-level step of cycle " + cycle.id());
            }
            Set<String> earlierTops = Set.copyOf(tops.subList(0, fromIndex));
            for (String key : parentOf.keySet()) {
                String top = key;
                while (parentOf.get(top) != null) {
                    top = parentOf.get(top);
                }
                if (earlierTops.contains(top)) {
                    before.add(key);
                }
            }
        }
        return seed.variableTimeline().stream()
                .filter(change -> change.stepKey() == null || command.fromStepKey() == null || before.contains(change.stepKey()))
                .toList();
    }

    /**
     * A cycle stamped before the index existed has SEMANTIC_V1 hashes and a null map. Store that map
     * once from the hashes already on the steps. Bodies are not read and hashes are not recomputed.
     * An empty map is left null so a cycle that still has no fingerprints is not rewritten at start.
     */
    private ReliveCycle persistIndexIfAbsent(ReliveCycle cycle) {
        if (cycle.fingerprintIndex() != null) {
            return cycle;
        }
        Map<String, Map<String, List<String>>> index = StepFingerprints.indexes(cycle.steps());
        if (index.isEmpty()) {
            return cycle;
        }
        String now = Instant.now().toString();
        ReliveCycle indexed = new ReliveCycle(
                cycle.id(), cycle.name(), cycle.description(), cycle.steps(),
                cycle.variables(), cycle.cycleRules(), cycle.globalRules(), cycle.settings(),
                cycle.noise(), cycle.unexpectedCalls(), cycle.createdAt(), now,
                cycle.isTransient(), cycle.lastRun(), index);
        ReliveCycle saved = cycleStore.save(indexed);
        notifications.cycleChanged();
        return saved;
    }

    /** Same one-time fill, on the run's own definition, so a later resume does not rebuild the map. */
    private ReliveCycle attachIndex(ReliveCycle cycle) {
        if (cycle.fingerprintIndex() != null) {
            return cycle;
        }
        Map<String, Map<String, List<String>>> index = StepFingerprints.indexes(cycle.steps());
        if (index.isEmpty()) {
            return cycle;
        }
        return new ReliveCycle(
                cycle.id(), cycle.name(), cycle.description(), cycle.steps(),
                cycle.variables(), cycle.cycleRules(), cycle.globalRules(), cycle.settings(),
                cycle.noise(), cycle.unexpectedCalls(), cycle.createdAt(), cycle.updatedAt(),
                cycle.isTransient(), cycle.lastRun(), index);
    }

    @Override
    public void recordStepResult(String runId, StepResult result) {
        synchronized (lockFor(runId)) {
            recordStepResultLocked(runId, result);
        }
    }

    private void recordStepResultLocked(String runId, StepResult result) {
        runStore.putStepResult(result);
        Run run = getOrThrow(runId);
        Run summarized = withSummary(run, computeSummary(run.definition(), runStore.listStepResults(runId)));
        runStore.update(withLog(summarized, stepLog(result)));
    }

    /** FR-038: what happened to a step, in the run's own log - only once it has an outcome. */
    private static List<LogEntry> stepLog(StepResult result) {
        if (result.state() == null || result.state() == StepState.RUNNING || result.state() == StepState.PENDING
                || result.state() == StepState.WAITING || result.state() == StepState.PAUSED) {
            return List.of();
        }
        String at = result.finishedAt() != null ? result.finishedAt() : Instant.now().toString();
        String message = "Attempt " + result.attempt() + ": " + result.state()
                + (result.error() == null ? "" : " - " + result.error());
        return List.of(new LogEntry(at, result.stepKey(), result.state() == StepState.FAILED ? "ERROR" : "SENT", message));
    }

    private static Run withLog(Run run, List<LogEntry> entries) {
        if (entries.isEmpty()) {
            return run;
        }
        List<LogEntry> log = new ArrayList<>(run.log());
        log.addAll(entries);
        return new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                run.definition(), run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                run.hold(), run.resumed(), log);
    }

    /** One call the proxy handled for this run (FR-038): matched where, replayed or forwarded,
     *  which rules applied, and whether its request differed from the recording. */
    private void logCall(ObservedCall call, JsonNode relive, String direction) {
        String runId = runIdOf(relive);
        String attribution = relive.path("attribution").asText("");
        String target = (call.method() == null ? "" : call.method() + " ") + (call.url() == null ? call.callId() : call.url());
        List<LogEntry> entries = new ArrayList<>();
        String at = call.at() == null ? Instant.now().toString() : call.at();
        String stepKey = stepKeyOf(relive);
        if (relive.path("unexpected").asBoolean(false) || "UNEXPECTED".equals(attribution)) {
            entries.add(new LogEntry(at, stepKey, "UNEXPECTED_CALL", target + " matched no step"
                    + (call.reachedUpstream() ? " - sent to the real system" : " - answered by ALFRED")));
        } else {
            String how = "STOPPING".equals(relive.path("choice").asText()) ? "BLOCKED"
                    : call.reachedUpstream() ? "FORWARDED_LIVE" : "REPLAYED";
            entries.add(new LogEntry(at, stepKey, how, direction + " " + target + " (" + attribution.toLowerCase()
                    + (call.status() == null ? "" : ", " + call.status()) + ")"));
        }
        if (relive.path("requestChanged").asBoolean(false)) {
            entries.add(new LogEntry(at, stepKey, "REQUEST_CHANGED", target + " differs from the recording"));
        }
        for (JsonNode rule : relive.path("ruleIds")) {
            entries.add(new LogEntry(at, stepKey, "RULE_APPLIED",
                    rule.path("tier").asText() + " rule \"" + rule.path("ruleName").asText(rule.path("ruleId").asText()) + "\""));
        }
        synchronized (lockFor(runId)) {
            runStore.findById(runId).ifPresent(run -> runStore.update(withLog(run, entries)));
        }
    }

    @Override
    public void setVariable(String runId, String name, String value, String stepKey) {
        synchronized (lockFor(runId)) {
            setVariableLocked(runId, name, value, stepKey);
        }
    }

    private void setVariableLocked(String runId, String name, String value, String stepKey) {
        Run run = getOrThrow(runId);
        List<VariableChange> timeline = new ArrayList<>(run.variableTimeline());
        timeline.add(new VariableChange(name, value, stepKey, Instant.now().toString()));
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                run.definition(), run.fromStepKey(), run.seedVariables(), timeline, run.summary(), run.hold(),
                run.resumed(), run.log());
        updated = withLog(updated, List.of(new LogEntry(Instant.now().toString(), stepKey, "VARIABLE_SET",
                "{{$." + name + "}} set" + (stepKey == null ? "" : " by this step"))));
        runStore.update(updated);
        if (isReferencedByARule(updated.definition(), name)) {
            publisher.publish(runId, snapshotBuilder.build(updated));
        }
        notifications.runChanged(run.cycleId(), runId);
    }

    @Override
    public Run stop(String runId) {
        synchronized (lockFor(runId)) {
            return stopLocked(runId);
        }
    }

    private Run stopLocked(String runId) {
        return finalizeIfRunning(getOrThrow(runId), RunStatus.STOPPED);
    }

    @Override
    public int stopAllRunning(String cycleId) {
        List<Run> running = runStore.findAllRunning().stream()
                .filter(run -> run.cycleId().equals(cycleId))
                .toList();
        running.forEach(run -> stop(run.id()));
        return running.size();
    }

    @Override
    public int stopSelected(String cycleId, Collection<String> runIds) {
        int stopped = 0;
        for (String runId : runIds) {
            Optional<Run> target = runStore.findById(runId)
                    .filter(run -> run.cycleId().equals(cycleId))
                    .filter(run -> run.status() == RunStatus.RUNNING);
            if (target.isPresent()) {
                stop(runId);
                stopped++;
            }
        }
        return stopped;
    }

    @Override
    public DeletedRunHistory delete(String cycleId, DeleteRunHistoryCommand command) {
        List<String> requested = command.runIds() == null || command.runIds().isEmpty()
                ? runStore.listByCycleId(cycleId, ReliveLimits.MAX_LIST_LIMIT).stream().map(Run::id).toList()
                : command.runIds();
        List<Run> targets = requested.stream()
                .map(runStore::findById)
                .flatMap(Optional::stream)
                .filter(run -> run.cycleId().equals(cycleId))
                .toList();
        // A run that settled between selection and this call is left alone; one the user is wiping
        // mid-flight is stopped through the same drain-safe path as a manual stop first - deletion
        // while its snapshot is still live could let a REPLAY child reach the real supplier.
        targets.stream().filter(run -> run.status() == RunStatus.RUNNING)
                .forEach(run -> stop(run.id()));
        if (targets.isEmpty()) {
            return new DeletedRunHistory(0, false);
        }
        Set<String> ids = targets.stream().map(Run::id).collect(Collectors.toSet());
        if (command.deleteCalls()) {
            // The Live-calls rows are the run history's own index into real calls - removed now,
            // while the History tab's reload right after this response still sees them gone. The
            // logged calls themselves can take longer to purge (the file-backed inbound store has
            // to scan its whole log), so that cleanup runs in the background: the delete responds
            // as soon as the history is gone, and each call store broadcasts its own
            // "calls-cleared" the moment its rows are actually removed - the dashboard refetches
            // on that signal and updates without a reload.
            liveCallStore.deleteByRunIds(ids);
            Set<String> toClean = Set.copyOf(ids);
            callsCleanupExecutor.execute(() -> {
                try {
                    relatedCalls.deleteByRunIds(toClean);
                } catch (RuntimeException e) {
                    log.error("Background cleanup of the logged calls for relive runs {} failed", toClean, e);
                }
            });
        }
        runStore.deleteByIds(ids);
        ids.forEach(runLocks::remove);
        notifications.runChanged(cycleId, null);
        return new DeletedRunHistory(ids.size(), command.deleteCalls());
    }

    @Override
    public Run finish(String runId, RunStatus status) {
        synchronized (lockFor(runId)) {
            return finishLocked(runId, status);
        }
    }

    private Run finishLocked(String runId, RunStatus status) {
        return finalizeIfRunning(getOrThrow(runId), status);
    }

    /** T047's RunLeaseRegistry calls this once the last lease holder is gone for 15s - same
     *  drain-safe path as stop/finish, just a different terminal status. */
    public Run interrupt(String runId) {
        synchronized (lockFor(runId)) {
            return interruptLocked(runId);
        }
    }

    private Run interruptLocked(String runId) {
        return runStore.findById(runId).map(run -> finalizeIfRunning(run, RunStatus.INTERRUPTED)).orElse(null);
    }

    /** A run ends once. Ending it again (a late interrupt after the tab closed, a second stop)
     *  would overwrite its real outcome and finish time, so it is returned unchanged. */
    private Run finalizeIfRunning(Run run, RunStatus status) {
        if (run.status() != RunStatus.RUNNING) {
            return run;
        }
        return finalizeRun(run, status);
    }

    @Override
    public Run hold(String runId, String stepKey, String reason) {
        synchronized (lockFor(runId)) {
            return holdLocked(runId, stepKey, reason);
        }
    }

    private Run holdLocked(String runId, String stepKey, String reason) {
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
        synchronized (lockFor(runId)) {
            return resumeLocked(runId, afterStepKey);
        }
    }

    private Run resumeLocked(String runId, String afterStepKey) {
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
                attachIndex(run.definition()), run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                null, resumed, run.log());
        runStore.update(updated);
        publisher.publish(runId, snapshotBuilder.build(updated));
        notifications.runChanged(run.cycleId(), runId);
        return updated;
    }

    @Override
    public Run updateDefinition(String runId, ReliveCycle definition, String reason) {
        synchronized (lockFor(runId)) {
            return updateDefinitionLocked(runId, definition, reason);
        }
    }

    private Run updateDefinitionLocked(String runId, ReliveCycle definition, String reason) {
        Run run = getOrThrow(runId);
        Set<String> resultKeys = runStore.listStepResults(runId).stream().map(StepResult::stepKey).collect(Collectors.toSet());
        Map<String, Step> incomingByKey = new LinkedHashMap<>();
        StepFingerprints.maintain(definition.steps(), run.definition().steps())
                .forEach(s -> incomingByKey.put(s.key(), s));

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
                run.definition().lastRun(), StepFingerprints.indexes(mergedSteps));
        // FR-044a: the change is part of the run's own record.
        List<LogEntry> log = new ArrayList<>(run.log());
        log.add(new LogEntry(Instant.now().toString(), null, "DEFINITION_UPDATED",
                reason == null || reason.isBlank() ? "Cycle edited during the run" : reason));
        Run updated = new Run(run.id(), run.cycleId(), run.driver(), run.status(), run.startedAt(), run.finishedAt(),
                mergedDefinition, run.fromStepKey(), run.seedVariables(), run.variableTimeline(), run.summary(),
                run.hold(), run.resumed(), log);
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
        leaseQuery.forget(run.id());
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

    /** FR-003c: an unsaved "Relive now" is offered "Save as cycle" after its run ends, so it is
     *  removed only TRANSIENT_KEEP_MS later, and only if it is still transient (Save as cycle,
     *  ManageReliveCyclesUseCase.keep, clears the flag) and no other run of it is going. The check
     *  reads the CURRENT stored cycle, never the run's frozen definition. */
    private void cleanupIfTransient(Run run) {
        if (cycleStore.findById(run.cycleId()).map(ReliveCycle::isTransient).orElse(false)) {
            scheduler.schedule(() -> deleteIfStillTransient(run.cycleId()), TRANSIENT_KEEP_MS, TimeUnit.MILLISECONDS);
        }
    }

    void deleteIfStillTransient(String cycleId) {
        cycleStore.findById(cycleId).ifPresent(current -> {
            boolean running = runStore.findAllRunning().stream().anyMatch(r -> r.cycleId().equals(cycleId));
            if (current.isTransient() && !running) {
                runStore.deleteByCycleId(cycleId);
                cycleStore.deleteById(cycleId);
                notifications.cycleChanged();
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
        if (runIdOf(relive) == null) {
            return;
        }
        // No in-flight entry: only an inbound execution owns outbound calls. Listing a supplier
        // call made a sibling issued at the same time look like that supplier's own child.
        broadcastRunCall(call, relive, "outbound", "IN_PROGRESS");
    }

    @Override
    public void onOutboundCallCompleted(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        JsonNode relive = call.relive();
        if (runIdOf(relive) == null) {
            return;
        }
        broadcastRunCall(call, relive, "outbound", "COMPLETED");
        logCall(call, relive, "outbound");
        maybeAddLiveCall(call, relive);
    }

    @Override
    public void onInboundCallPrepared(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        JsonNode relive = call.relive();
        String runId = runIdOf(relive);
        if (runId == null) {
            return;
        }
        // The app may issue an outbound child immediately after receiving this request. Publish
        // its parent context before the reverse proxy forwards the inbound call upstream.
        addInflightEntry(call.serviceName(), call.callId(), runId, stepKeyOf(relive));
    }

    @Override
    public void onInboundCallCompleted(ObservedCall call) {
        if (handleAmbiguousIfPresent(call)) {
            return;
        }
        removeInflightEntry(call.callId());
        JsonNode relive = call.relive();
        if (runIdOf(relive) == null) {
            return;
        }
        broadcastRunCall(call, relive, "inbound", "COMPLETED");
        logCall(call, relive, "inbound");
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
            synchronized (lockFor(runId)) {
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
        // A child's own duration (FR-032): the browser has no other cheap way to learn it.
        if (call.durationMs() != null) {
            event.put("durationMs", call.durationMs());
        }
        if (relive.has("requestChanged")) {
            event.put("requestChanged", relive.path("requestChanged").asBoolean());
        }
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
                node.put("direction", "inbound");
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
