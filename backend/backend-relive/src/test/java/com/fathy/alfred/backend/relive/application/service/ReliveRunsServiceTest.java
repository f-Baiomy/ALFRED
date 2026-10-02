package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryCommand;
import com.fathy.alfred.backend.relive.application.port.in.DeleteRunHistoryUseCase;
import com.fathy.alfred.backend.relive.application.port.in.RunBlockedException;
import com.fathy.alfred.backend.relive.application.port.in.RunDefinitionConflictException;
import com.fathy.alfred.backend.relive.application.port.in.RunLeaseHeldException;
import com.fathy.alfred.backend.relive.application.port.in.RunNotResumableException;
import com.fathy.alfred.backend.relive.application.port.in.StartRunCommand;
import com.fathy.alfred.backend.relive.application.port.in.ValidateCycleUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LeaseQuery;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RelatedCallsPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.fingerprint.RequestFingerprint;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepState;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.Delayed;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReliveRunsServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private FakeCycleStore cycleStore;
    private FakeRunStore runStore;
    private FakePublisher publisher;
    private FakeNotifications notifications;
    private FakeValidator validator;
    private FakeLeaseQuery leaseQuery;
    private FakeScheduler scheduler;
    private FakeLiveCallStore liveCallStore;
    private FakeRelatedCalls relatedCalls;
    private ReliveRunsService service;

    @BeforeEach
    void setUp() {
        cycleStore = new FakeCycleStore();
        runStore = new FakeRunStore();
        publisher = new FakePublisher();
        notifications = new FakeNotifications();
        validator = new FakeValidator();
        leaseQuery = new FakeLeaseQuery();
        scheduler = new FakeScheduler();
        liveCallStore = new FakeLiveCallStore();
        relatedCalls = new FakeRelatedCalls();
        RunSnapshotBuilder snapshotBuilder = new RunSnapshotBuilder(publisher, objectMapper);
        service = new ReliveRunsService(runStore, cycleStore, publisher, notifications, validator,
                snapshotBuilder, leaseQuery, scheduler, liveCallStore, relatedCalls, Runnable::run);
    }

    private ReliveCycle bareCycle(String name, boolean isTransient) {
        return new ReliveCycle(null, name, null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"),
                "t0", "t0", isTransient, null);
    }

    private Step step(String key, boolean inbound) {
        return new Step(key, null, "label", true, false, inbound ? "inbound" : "outbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", null, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
    }

    private ReliveCycle withSteps(ReliveCycle base, List<Step> steps) {
        return new ReliveCycle(base.id(), base.name(), base.description(), steps, base.variables(),
                base.cycleRules(), base.globalRules(), base.settings(), base.noise(), base.unexpectedCalls(),
                base.createdAt(), base.updatedAt(), base.isTransient(), base.lastRun());
    }

    private String save(ReliveCycle cycle) {
        ReliveCycle toSave = cycle.id() == null
                ? new ReliveCycle(java.util.UUID.randomUUID().toString(), cycle.name(), cycle.description(),
                        cycle.steps(), cycle.variables(), cycle.cycleRules(), cycle.globalRules(), cycle.settings(),
                        cycle.noise(), cycle.unexpectedCalls(), cycle.createdAt(), cycle.updatedAt(),
                        cycle.isTransient(), cycle.lastRun())
                : cycle;
        cycleStore.save(toSave);
        return toSave.id();
    }

    @Test
    void startThrowsWhenValidationBlocks() {
        String cycleId = save(bareCycle("blocked", false));
        validator.findings = List.of(new ValidationFinding("BLOCK", "MISSING_RECORDING", "s-1", "no recording"));

        assertThatThrownBy(() -> service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of())))
                .isInstanceOf(RunBlockedException.class);
        assertThat(publisher.published).isEmpty();
    }

    @Test
    void startPublishesSnapshotAndNotifies() {
        String cycleId = save(bareCycle("ok", false));

        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        assertThat(run.status()).isEqualTo(RunStatus.RUNNING);
        assertThat(publisher.published).containsKey(run.id());
        assertThat(publisher.published.get(run.id()).get("state").asText()).isEqualTo("RUNNING");
        assertThat(notifications.runChangedCount).isEqualTo(1);
    }

    @Test
    void recordStepResultRecomputesSummary() {
        String cycleId = save(withSteps(bareCycle("steps", false), List.of(step("s-1", true))));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        service.recordStepResult(run.id(), stepResult(run.id(), "s-1", 1, StepState.COMPLETED));

        Run updated = runStore.findById(run.id()).orElseThrow();
        assertThat(updated.summary().completed()).isEqualTo(1);
        assertThat(updated.summary().total()).isEqualTo(1);
    }

    @Test
    void setVariableRepublishesOnlyWhenReferencedByARule() {
        JsonNode ruleUsingToken = objectMapper.createObjectNode().put("match", "{{$.token}}");
        CycleRule cycleRule = new CycleRule(ruleUsingToken, null);
        ReliveCycle cycle = new ReliveCycle(null, "vars", null, List.of(), List.of(), List.of(cycleRule),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        String cycleId = save(cycle);
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        publisher.published.clear();

        service.setVariable(run.id(), "unused", "v1", null);
        assertThat(publisher.published).isEmpty();

        service.setVariable(run.id(), "token", "v2", null);
        assertThat(publisher.published).containsKey(run.id());
    }

    @Test
    void stopKeepsSnapshotAsStoppingUntilDrainOrTimeout() {
        String cycleId = save(bareCycle("stoppable", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        service.stop(run.id());

        assertThat(publisher.unpublished).doesNotContain(run.id());
        assertThat(publisher.published.get(run.id()).get("state").asText()).isEqualTo("STOPPING");
        assertThat(scheduler.tasks).hasSize(1);
    }

    @Test
    void stopAllRunningStopsEveryRunningRunOfTheCycle() {
        String cycleId = save(bareCycle("bulk", false));
        String otherCycleId = save(bareCycle("other", false));
        Run first = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        Run second = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.start(otherCycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.finish(second.id(), RunStatus.COMPLETED);

        int stopped = service.stopAllRunning(cycleId);

        assertThat(stopped).isEqualTo(1);
        assertThat(runStore.findById(first.id()).orElseThrow().status()).isEqualTo(RunStatus.STOPPED);
        assertThat(runStore.findAllRunning()).allSatisfy(run -> assertThat(run.cycleId()).isEqualTo(otherCycleId));
    }

    @Test
    void stopSelectedSkipsForeignAndSettledRuns() {
        String cycleId = save(bareCycle("bulk", false));
        String otherCycleId = save(bareCycle("other", false));
        Run mine = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        Run settled = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.finish(settled.id(), RunStatus.FAILED);
        Run foreign = service.start(otherCycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        int stopped = service.stopSelected(cycleId, List.of(mine.id(), settled.id(), foreign.id()));

        assertThat(stopped).isEqualTo(1);
        assertThat(runStore.findById(mine.id()).orElseThrow().status()).isEqualTo(RunStatus.STOPPED);
        assertThat(runStore.findById(foreign.id()).orElseThrow().status()).isEqualTo(RunStatus.RUNNING);
    }

    @Test
    void deleteHistoryRemovesRunsAndTheirStepResults() {
        String cycleId = save(bareCycle("history", false));
        Run gone = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        Run kept = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.finish(kept.id(), RunStatus.COMPLETED);

        DeleteRunHistoryUseCase.DeletedRunHistory deleted =
                service.delete(cycleId, new DeleteRunHistoryCommand(List.of(gone.id()), false));

        assertThat(deleted.runs()).isEqualTo(1);
        assertThat(deleted.callsCleanupStarted()).isFalse();
        assertThat(runStore.findById(gone.id())).isEmpty();
        assertThat(runStore.listStepResults(gone.id())).isEmpty();
        assertThat(runStore.findById(kept.id())).isPresent();
        assertThat(relatedCalls.deletedRunIds).isEmpty();
    }

    @Test
    void deleteAllHistoryStopsRunningRunsAndOptionallyDeletesRelatedCalls() {
        String cycleId = save(bareCycle("history", false));
        Run running = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        liveCallStore.add(new LiveCall(java.util.UUID.randomUUID().toString(), cycleId, running.id(),
                null, "LIVE", "call-1", null, null, 200, 5, "t0"));

        DeleteRunHistoryUseCase.DeletedRunHistory deleted =
                service.delete(cycleId, DeleteRunHistoryCommand.all(true));

        assertThat(deleted.runs()).isEqualTo(1);
        assertThat(deleted.callsCleanupStarted()).isTrue();
        assertThat(runStore.findById(running.id())).isEmpty();
        assertThat(runStore.listStepResults(running.id())).isEmpty();
        assertThat(relatedCalls.deletedRunIds).containsExactly(running.id());
        assertThat(liveCallStore.calls).isEmpty();
        // The run was RUNNING when selected: stopping it first republished its snapshot as
        // STOPPING, and deletion deliberately leaves its removal to the drain path - the
        // snapshot must not vanish while in-flight REPLAY children might still consult it.
        assertThat(publisher.published.get(running.id()).get("state").asText()).isEqualTo("STOPPING");
    }

    @Test
    void deleteHistoryKeepsCallsWhenAskedTo() {
        String cycleId = save(bareCycle("history", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.finish(run.id(), RunStatus.COMPLETED);

        DeleteRunHistoryUseCase.DeletedRunHistory deleted =
                service.delete(cycleId, new DeleteRunHistoryCommand(List.of(), false));

        assertThat(deleted.runs()).isEqualTo(1);
        assertThat(deleted.callsCleanupStarted()).isFalse();
        assertThat(relatedCalls.deletedRunIds).isEmpty();
        assertThat(runStore.findById(run.id())).isEmpty();
    }

    @Test
    void stopSnapshotIsRemovedOnSimulatedDrain() {
        String cycleId = save(bareCycle("stoppable", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.stop(run.id());

        service.onInflightDrained(run.id());

        assertThat(publisher.unpublished).contains(run.id());
        assertThat(scheduler.tasks.get(0).cancelled).isTrue();
    }

    @Test
    void stopSnapshotIsRemovedAfterSimulatedTimeoutWithNoDrain() {
        String cycleId = save(bareCycle("stoppable", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.stop(run.id());

        scheduler.tasks.get(0).runnable.run();

        assertThat(publisher.unpublished).contains(run.id());
    }

    @Test
    void finishDeletesAnUnsavedTransientCycleAndItsRun() {
        String cycleId = save(bareCycle("quick run", true));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        service.finish(run.id(), RunStatus.COMPLETED);

        assertThat(cycleStore.findById(cycleId)).isEmpty();
        assertThat(runStore.findById(run.id())).isEmpty();
    }

    @Test
    void finishKeepsACycleSavedMidRun() {
        String cycleId = save(bareCycle("was quick", true));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        ReliveCycle stored = cycleStore.findById(cycleId).orElseThrow();
        cycleStore.save(new ReliveCycle(stored.id(), stored.name(), stored.description(), stored.steps(),
                stored.variables(), stored.cycleRules(), stored.globalRules(), stored.settings(), stored.noise(),
                stored.unexpectedCalls(), stored.createdAt(), stored.updatedAt(), false, stored.lastRun()));

        service.finish(run.id(), RunStatus.COMPLETED);

        assertThat(cycleStore.findById(cycleId)).isPresent();
        assertThat(runStore.findById(run.id())).isPresent();
    }

    @Test
    void holdSetsHoldAndLogsThenClearsAndLogsContinued() {
        String cycleId = save(bareCycle("holdable", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        Run held = service.hold(run.id(), "s-1", "FAILED");
        assertThat(held.hold()).isNotNull();
        assertThat(held.log()).anyMatch(l -> "HELD".equals(l.kind()));

        Run continued = service.hold(run.id(), "s-1", null);
        assertThat(continued.hold()).isNull();
        assertThat(continued.log()).anyMatch(l -> "CONTINUED".equals(l.kind()));
    }

    @Test
    void resumeOnlyWorksFromAnEndedStatus() {
        String cycleId = save(bareCycle("running", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        assertThatThrownBy(() -> service.resume(run.id(), null)).isInstanceOf(RunNotResumableException.class);
    }

    @Test
    void resumeRejectsWhileAnotherTabHoldsTheLease() {
        String cycleId = save(bareCycle("stopped", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.stop(run.id());
        leaseQuery.active = true;

        assertThatThrownBy(() -> service.resume(run.id(), null)).isInstanceOf(RunLeaseHeldException.class);
    }

    @Test
    void resumeReactivatesTheRun() {
        String cycleId = save(bareCycle("stopped", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.stop(run.id());

        Run resumed = service.resume(run.id(), "s-2");

        assertThat(resumed.status()).isEqualTo(RunStatus.RUNNING);
        assertThat(resumed.resumed()).hasSize(1);
        assertThat(publisher.published.get(run.id()).get("state").asText()).isEqualTo("RUNNING");
    }

    @Test
    void updateDefinitionMergesOnlyUnexecutedSteps() {
        String cycleId = save(withSteps(bareCycle("defs", false), List.of(step("s-1", true), step("s-2", true))));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.recordStepResult(run.id(), stepResult(run.id(), "s-1", 1, StepState.COMPLETED));

        Step changedS2 = new Step("s-2", null, "changed label", true, false, "inbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", null, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        ReliveCycle newDefinition = withSteps(cycleStore.findById(cycleId).orElseThrow(), List.of(step("s-1", true), changedS2));

        Run updated = service.updateDefinition(run.id(), newDefinition, "tweak");

        assertThat(updated.definition().steps().stream().filter(s -> s.key().equals("s-2")).findFirst().orElseThrow().label())
                .isEqualTo("changed label");
    }

    @Test
    void startingARunPersistsAMissingIndexOnceWithoutRehashing() {
        FrozenCall recorded = new FrozenCall("POST", "https://api.supplier.com/search", Map.of(),
                "{\"huge\":true}", 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");
        Step child = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "not-a-real-hash", RequestFingerprint.VERSION);
        String cycleId = save(withSteps(bareCycle("stored", false), List.of(step("s-in", true), child)));

        Run first = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        JsonNode parent = publisher.published.get(first.id()).path("steps").get(0);
        JsonNode published = parent.path("children").get(0);
        assertThat(published.path("fingerprint").asText()).isEqualTo("not-a-real-hash");
        assertThat(published.path("fingerprintVersion").asText()).isEqualTo(RequestFingerprint.VERSION);
        assertThat(published.path("enabled").asBoolean()).isTrue();
        assertThat(parent.path("fingerprintIndex").path("not-a-real-hash").get(0).asText()).isEqualTo("c-1");
        ReliveCycle indexed = cycleStore.findById(cycleId).orElseThrow();
        assertThat(indexed.updatedAt()).isNotEqualTo("t0");
        assertThat(indexed.fingerprintIndex().get("s-in").get("not-a-real-hash")).containsExactly("c-1");
        assertThat(indexed.steps().get(1).fingerprint()).isEqualTo("not-a-real-hash");

        Run second = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        assertThat(second.definition().steps().get(1).fingerprint()).isEqualTo("not-a-real-hash");
        assertThat(cycleStore.findById(cycleId).orElseThrow().updatedAt()).isEqualTo(indexed.updatedAt());
        assertThat(cycleStore.findById(cycleId).orElseThrow().fingerprintIndex()).isEqualTo(indexed.fingerprintIndex());
    }

    @Test
    void resumeAttachesAMissingIndexWithoutRehashingOrRewritingTheCycle() {
        FrozenCall recorded = new FrozenCall("POST", "https://api.supplier.com/search", Map.of(),
                "{\"huge\":true}", 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");
        Step child = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "not-a-real-hash", RequestFingerprint.VERSION);
        String cycleId = save(withSteps(bareCycle("stored", false), List.of(step("s-in", true), child)));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.stop(run.id());
        String cycleUpdatedAt = cycleStore.findById(cycleId).orElseThrow().updatedAt();

        Run stopped = runStore.byId.get(run.id());
        ReliveCycle stripped = new ReliveCycle(
                stopped.definition().id(), stopped.definition().name(), stopped.definition().description(),
                stopped.definition().steps(), stopped.definition().variables(), stopped.definition().cycleRules(),
                stopped.definition().globalRules(), stopped.definition().settings(), stopped.definition().noise(),
                stopped.definition().unexpectedCalls(), stopped.definition().createdAt(), stopped.definition().updatedAt(),
                stopped.definition().isTransient(), stopped.definition().lastRun(), null);
        runStore.byId.put(stopped.id(), new Run(
                stopped.id(), stopped.cycleId(), stopped.driver(), stopped.status(), stopped.startedAt(), stopped.finishedAt(),
                stripped, stopped.fromStepKey(), stopped.seedVariables(), stopped.variableTimeline(), stopped.summary(),
                stopped.hold(), stopped.resumed(), stopped.log()));

        Run resumed = service.resume(run.id(), "s-in");
        assertThat(resumed.definition().steps().get(1).fingerprint()).isEqualTo("not-a-real-hash");
        assertThat(resumed.definition().fingerprintIndex().get("s-in").get("not-a-real-hash")).containsExactly("c-1");
        assertThat(cycleStore.findById(cycleId).orElseThrow().updatedAt()).isEqualTo(cycleUpdatedAt);
        assertThat(publisher.published.get(run.id()).path("steps").get(0).path("fingerprintIndex").path("not-a-real-hash").get(0).asText())
                .isEqualTo("c-1");
    }

    @Test
    void startingAnUnstampedCycleDoesNotFingerprint() {
        FrozenCall recorded = new FrozenCall("POST", "https://api.supplier.com/search", Map.of(),
                "{\"a\":1}", 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");
        Step child = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        String cycleId = save(withSteps(bareCycle("unstamped", false), List.of(step("s-in", true), child)));

        Run first = service.start(cycleId, new StartRunCommand("GUIDED", null, null, Map.of()));
        assertThat(first.definition().steps().get(1).fingerprint()).isNull();
        assertThat(first.definition().steps().get(1).fingerprintVersion()).isNull();
        assertThat(cycleStore.findById(cycleId).orElseThrow().updatedAt()).isEqualTo("t0");
        assertThat(publisher.published.get(first.id()).path("steps").get(0).path("fingerprintIndex").isMissingNode()).isTrue();
        assertThat(publisher.published.get(first.id()).path("steps").get(0).path("children").get(0).has("fingerprint")).isFalse();

        Run second = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        assertThat(second.definition().steps().get(1).fingerprint()).isNull();
        assertThat(cycleStore.findById(cycleId).orElseThrow().updatedAt()).isEqualTo("t0");
    }

    @Test
    void updateDefinitionKeepsTheStoredHashWhenTheClientOmitsIt() {
        FrozenCall recorded = new FrozenCall("POST", "https://api.supplier.com/search", Map.of(),
                "{\"a\":1}", 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");
        String hash = RequestFingerprint.of(recorded);
        Step child = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                hash, RequestFingerprint.VERSION);
        String cycleId = save(withSteps(bareCycle("stamp", false), List.of(step("s-in", true), child)));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        Step stored = run.definition().steps().get(1);
        assertThat(stored.fingerprint()).isEqualTo(hash);

        Step omitted = new Step(stored.key(), stored.parentKey(), stored.label(), stored.enabled(), stored.optional(),
                stored.direction(), stored.serviceName(), stored.callRule(), stored.unattributed(), stored.recording(),
                stored.source(), stored.extract(), stored.assertions(), stored.noise(), null, null);
        Run stamped = service.updateDefinition(run.id(),
                withSteps(run.definition(), List.of(run.definition().steps().get(0), omitted)), null);
        assertThat(stamped.definition().steps().get(1).fingerprint()).isEqualTo(hash);

        service.recordStepResult(run.id(), stepResult(run.id(), "c-1", 1, StepState.COMPLETED));
        Run kept = service.updateDefinition(run.id(),
                withSteps(stamped.definition(), List.of(stamped.definition().steps().get(0), omitted)), null);
        assertThat(kept.definition().steps().get(1).fingerprint()).isEqualTo(hash);
    }

    @Test
    void updateDefinitionRejectsChangingAStepThatAlreadyHasAResult() {
        String cycleId = save(withSteps(bareCycle("defs", false), List.of(step("s-1", true))));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        service.recordStepResult(run.id(), stepResult(run.id(), "s-1", 1, StepState.COMPLETED));

        Step changedS1 = new Step("s-1", null, "changed", true, false, "inbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", null, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        ReliveCycle newDefinition = withSteps(cycleStore.findById(cycleId).orElseThrow(), List.of(changedS1));

        assertThatThrownBy(() -> service.updateDefinition(run.id(), newDefinition, null))
                .isInstanceOf(RunDefinitionConflictException.class);
    }

    @Test
    void outboundCallPreparedBroadcastsWithoutAnInflightEntry() {
        String cycleId = save(bareCycle("inflight", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        int publishedBefore = publisher.inflightPublishedCount;

        JsonNode relive = objectMapper.createObjectNode().put("runId", run.id()).put("stepKey", "s-1").put("attribution", "HEADER");
        service.onOutboundCallPrepared(new com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase.ObservedCall(
                "call-1", "odeysys", relive, false, null, null, null, null, null));

        // Review B1: a supplier call in flight must never become the owner of its siblings.
        assertThat(publisher.inflightPublishedCount).isEqualTo(publishedBefore);
        assertThat(notifications.runCallEvents).hasSize(1);
        assertThat(notifications.runCallEvents.get(0).get("direction").asText()).isEqualTo("outbound");
    }

    @Test
    void inboundCallCompletedRemovesInflightEntryAndDrainsAStoppingRun() {
        String cycleId = save(bareCycle("drain", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        JsonNode relive = objectMapper.createObjectNode().put("runId", run.id()).put("stepKey", "s-1");
        service.onInboundCallPrepared(new com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase.ObservedCall(
                "call-1", "odeysys", relive, false, null, null, null, null, null));
        service.stop(run.id());
        assertThat(publisher.unpublished).doesNotContain(run.id());

        service.onInboundCallCompleted(new com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase.ObservedCall(
                "call-1", "odeysys", relive, false, null, null, null, null, null));

        assertThat(publisher.unpublished).contains(run.id());
    }

    @Test
    void ambiguousCallLogsAgainstEveryMatchedRun() {
        String cycleId1 = save(bareCycle("a", false));
        String cycleId2 = save(bareCycle("b", false));
        Run runA = service.start(cycleId1, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        Run runB = service.start(cycleId2, new StartRunCommand("AUTOMATIC", null, null, Map.of()));

        JsonNode reliveWrapper = objectMapper.createObjectNode().set("ambiguousRunIds",
                objectMapper.createArrayNode().add(runA.id()).add(runB.id()));
        service.onOutboundCallCompleted(new com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase.ObservedCall(
                "call-x", "odeysys", reliveWrapper, false, null, null, null, null, null));

        assertThat(runStore.findById(runA.id()).orElseThrow().log()).anyMatch(l -> "AMBIGUOUS_BLOCKED".equals(l.kind()));
        assertThat(runStore.findById(runB.id()).orElseThrow().log()).anyMatch(l -> "AMBIGUOUS_BLOCKED".equals(l.kind()));
    }

    @Test
    void reachedUpstreamAddsALiveCall() {
        String cycleId = save(bareCycle("livecall", false));
        Run run = service.start(cycleId, new StartRunCommand("AUTOMATIC", null, null, Map.of()));
        JsonNode relive = objectMapper.createObjectNode().put("runId", run.id()).put("stepKey", "s-1");

        service.onInboundCallCompleted(new com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase.ObservedCall(
                "call-2", "odeysys", relive, true, null, null, 200, 5L, "t1"));

        assertThat(liveCallStore.calls).hasSize(1);
        assertThat(liveCallStore.calls.get(0).runId()).isEqualTo(run.id());
    }

    private StepResult stepResult(String runId, String stepKey, int attempt, StepState state) {
        return new StepResult(runId, stepKey, attempt, state, "LIVE", "HEADER", null, null, null,
                List.of(), List.of(), List.of(), List.of(), null, "t0", "t1", 5L, null, List.of(), null, List.of(), null);
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
        @Override public void putStepResult(StepResult result) {
            stepResults.removeIf(r -> r.runId().equals(result.runId()) && r.stepKey().equals(result.stepKey()) && r.attempt() == result.attempt());
            stepResults.add(result);
        }
        @Override public List<StepResult> listStepResults(String runId) {
            return stepResults.stream().filter(r -> r.runId().equals(runId)).toList();
        }
        @Override public void pruneRuns(String cycleId, int keep, long maxBytes) { }
        @Override public void deleteByCycleId(String cycleId) {
            byId.values().removeIf(r -> r.cycleId().equals(cycleId));
            stepResults.removeIf(r -> !byId.containsKey(r.runId()));
        }
        @Override public void deleteByIds(Collection<String> runIds) {
            runIds.forEach(byId::remove);
            stepResults.removeIf(r -> !byId.containsKey(r.runId()));
        }
    }

    static class FakePublisher implements RunSnapshotPublisherPort {
        final Map<String, JsonNode> published = new LinkedHashMap<>();
        final List<String> unpublished = new ArrayList<>();
        int inflightPublishedCount;
        @Override public void publish(String runId, JsonNode snapshotJson) { published.put(runId, snapshotJson); }
        @Override public void unpublish(String runId) { unpublished.add(runId); published.remove(runId); }
        @Override public void publishInflight(JsonNode inflightJson) { inflightPublishedCount++; }
        @Override public void clearInflight() { }
        @Override public void writeAnswer(String runId, String answerId, JsonNode meta, byte[] body) { }
    }

    static class FakeNotifications implements ReliveNotificationPort {
        int runChangedCount;
        final List<JsonNode> runCallEvents = new ArrayList<>();
        @Override public void cycleChanged() { }
        @Override public void runChanged(String cycleId, String runId) { runChangedCount++; }
        @Override public void runCall(JsonNode eventJson) { runCallEvents.add(eventJson); }
    }

    static class FakeValidator implements ValidateCycleUseCase {
        List<ValidationFinding> findings = List.of();
        @Override public List<ValidationFinding> validate(String cycleId) { return findings; }
    }

    static class FakeLeaseQuery implements LeaseQuery {
        boolean active;
        @Override public boolean hasActiveLease(String runId) { return active; }
    }

    static class FakeLiveCallStore implements LiveCallStorePort {
        final List<LiveCall> calls = new ArrayList<>();
        @Override public LiveCall add(LiveCall call) { calls.add(call); return call; }
        @Override public List<LiveCall> list(String cycleId, int limit) {
            return calls.stream().filter(c -> c.cycleId().equals(cycleId)).toList();
        }
        @Override public Optional<LiveCall> findById(String id) {
            return calls.stream().filter(c -> c.id().equals(id)).findFirst();
        }
        @Override public boolean deleteById(String id) { return calls.removeIf(c -> c.id().equals(id)); }
        @Override public void deleteByRunIds(Collection<String> runIds) { calls.removeIf(c -> runIds.contains(c.runId())); }
        @Override public long totalBytes(String cycleId) { return 0L; }
    }

    static class FakeRelatedCalls implements RelatedCallsPort {
        final Set<String> deletedRunIds = new LinkedHashSet<>();
        int callsDeleted;
        @Override public int deleteByRunIds(Collection<String> runIds) {
            deletedRunIds.addAll(runIds);
            return callsDeleted;
        }
    }

    /** Captures every scheduled task instead of running it, so a test can invoke or cancel it deterministically. */
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
