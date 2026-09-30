package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.CycleInUseException;
import com.fathy.alfred.backend.relive.application.port.in.CycleValidationException;
import com.fathy.alfred.backend.relive.application.port.in.StaleCycleException;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RuleValidationPort;
import com.fathy.alfred.backend.relive.domain.fingerprint.RequestFingerprint;
import com.fathy.alfred.backend.relive.domain.model.CopiedFrom;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
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
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ReliveCyclesServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private FakeCycleStore cycleStore;
    private FakeRunStore runStore;
    private AtomicInteger notifyCount;
    private ReliveCyclesService service;

    @BeforeEach
    void setUp() {
        cycleStore = new FakeCycleStore();
        runStore = new FakeRunStore();
        notifyCount = new AtomicInteger();
        RuleValidationPort ruleValidation = doc -> {
            if (doc != null && doc.has("badAction")) {
                return List.of("unknown action type: bogus");
            }
            if (doc != null && doc.path("actions").isArray() && doc.path("actions").isEmpty()) {
                return List.of("A rule needs at least one action.");
            }
            return List.of();
        };
        ReliveNotificationPort notifications = new ReliveNotificationPort() {
            @Override public void cycleChanged() { notifyCount.incrementAndGet(); }
            @Override public void runChanged(String cycleId, String runId) { }
            @Override public void runCall(com.fasterxml.jackson.databind.JsonNode eventJson) { }
        };
        service = new ReliveCyclesService(cycleStore, runStore, ruleValidation, notifications);
    }

    private ReliveCycle bareCycle(String name) {
        return new ReliveCycle(null, name, null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"),
                null, null, false, null);
    }

    @Test
    void createNotifiesAndAssignsId() {
        ReliveCycle saved = service.create(bareCycle("My cycle"));
        assertThat(saved.id()).isNotBlank();
        assertThat(notifyCount.get()).isEqualTo(1);
    }

    @Test
    void createTransientMarksItTransient() {
        ReliveCycle saved = service.createTransient(bareCycle("Quick run"));
        assertThat(saved.isTransient()).isTrue();
    }

    @Test
    void rejectsBlankName() {
        assertThatThrownBy(() -> service.create(bareCycle("")))
                .isInstanceOf(CycleValidationException.class);
    }

    @Test
    void rejectsDuplicateStepKeys() {
        Step step = stepWithKey("s-1", null, "inbound");
        ReliveCycle cycle = withSteps(bareCycle("dup"), List.of(step, stepWithKey("s-1", null, "inbound")));
        assertThatThrownBy(() -> service.create(cycle)).isInstanceOf(CycleValidationException.class);
    }

    @Test
    void rejectsParentKeyNotResolvingToInboundStep() {
        Step orphanChild = stepWithKey("c-1", "missing-parent", "outbound");
        ReliveCycle cycle = withSteps(bareCycle("orphan"), List.of(orphanChild));
        assertThatThrownBy(() -> service.create(cycle)).isInstanceOf(CycleValidationException.class);
    }

    @Test
    void acceptsEmptyInboundPassThroughRuleButRejectsEmptyOutboundRule() {
        var emptyPipeline = objectMapper.createObjectNode();
        emptyPipeline.putArray("actions");
        Step inbound = withRule(stepWithKey("inbound", null, "inbound"), emptyPipeline);
        Step outbound = withRule(stepWithKey("outbound", null, "outbound"), emptyPipeline);

        assertThat(service.create(withSteps(bareCycle("inbound"), List.of(inbound))).steps()).containsExactly(inbound);
        assertThatThrownBy(() -> service.create(withSteps(bareCycle("outbound"), List.of(outbound))))
                .isInstanceOf(CycleValidationException.class)
                .hasMessageContaining("at least one action");
    }

    @Test
    void rejectsInvalidOrDuplicateVariableNames() {
        ReliveCycle cycle = new ReliveCycle(null, "vars", null, List.of(),
                List.of(new CycleVariable("1bad", "", false, null)), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), null, null, false, null);
        assertThatThrownBy(() -> service.create(cycle)).isInstanceOf(CycleValidationException.class);
    }

    @Test
    void everyCallRuleAndCycleRuleMustPassValidation() {
        Step badStep = new Step("s-1", null, "label", true, false, "inbound", "svc",
                new CycleRule(objectMapper.createObjectNode().put("badAction", true), null),
                "BLOCK", null, null, objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
        ReliveCycle cycle = withSteps(bareCycle("bad rule"), List.of(badStep));
        assertThatThrownBy(() -> service.create(cycle)).isInstanceOf(CycleValidationException.class);
    }

    @Test
    void updateWithStaleIfMatchThrows() {
        ReliveCycle saved = service.create(bareCycle("original"));
        assertThatThrownBy(() -> service.update(saved.id(), saved, "not-the-real-updatedAt", null))
                .isInstanceOf(StaleCycleException.class);
    }

    @Test
    void updateWithReasonSavesAVersionFirst() {
        ReliveCycle saved = service.create(bareCycle("v1"));
        ReliveCycle changed = new ReliveCycle(saved.id(), "v2", saved.description(), saved.steps(),
                saved.variables(), saved.cycleRules(), saved.globalRules(), saved.settings(), saved.noise(),
                saved.unexpectedCalls(), saved.createdAt(), saved.updatedAt(), saved.isTransient(), saved.lastRun());
        service.update(saved.id(), changed, saved.updatedAt(), "rebuild");
        List<CycleVersion> versions = cycleStore.listVersions(saved.id());
        assertThat(versions).hasSize(1);
        assertThat(versions.get(0).definition().name()).isEqualTo("v1");
    }

    @Test
    void deleteRefusedWhileARunningRunExists() {
        ReliveCycle saved = service.create(bareCycle("has a run"));
        runStore.runs.add(new Run("r-1", saved.id(), "AUTOMATIC", RunStatus.RUNNING, "t0", null,
                saved, null, List.of(), List.of(), null, null, List.of(), List.of()));
        assertThatThrownBy(() -> service.delete(saved.id())).isInstanceOf(CycleInUseException.class);
    }

    @Test
    void deleteSucceedsWithNoRunningRun() {
        ReliveCycle saved = service.create(bareCycle("no run"));
        service.delete(saved.id());
        assertThat(cycleStore.findById(saved.id())).isEmpty();
    }

    @Test
    void duplicateGetsANewIdAndCopySuffix() {
        ReliveCycle saved = service.create(bareCycle("orig"));
        ReliveCycle copy = service.duplicate(saved.id(), null);
        assertThat(copy.id()).isNotEqualTo(saved.id());
        assertThat(copy.name()).isEqualTo("orig (copy)");
    }

    @Test
    void createStampsAnOutboundRequestAndLeavesTheInboundUnhashed() {
        FrozenCall recorded = supplierCall("{\n  \"b\": 1,\n  \"a\": 2\n}");
        Step inbound = new Step("s-in", null, "search", true, false, "inbound", "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "should-clear", RequestFingerprint.VERSION);
        Step outbound = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(mockRule(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "client-hash", "NOPE");

        ReliveCycle saved = service.create(withSteps(bareCycle("fingerprints"), List.of(inbound, outbound)));

        Step parent = saved.steps().get(0);
        Step child = saved.steps().get(1);
        assertThat(parent.fingerprint()).isNull();
        assertThat(parent.fingerprintVersion()).isNull();
        assertThat(child.fingerprint()).isEqualTo(RequestFingerprint.of(recorded));
        assertThat(child.fingerprintVersion()).isEqualTo(RequestFingerprint.VERSION);
        assertThat(child.fingerprint()).isNotEqualTo("client-hash");
        assertThat(saved.fingerprintIndex().get("s-in").get(child.fingerprint())).containsExactly("c-1");
    }

    @Test
    void createCanDeferTheHashUntilFingerprintIsAsked() {
        FrozenCall recorded = supplierCall("{\"a\":1}");
        Step outbound = new Step("c-1", "s-in", "supplier", true, false, "outbound", "svc",
                new CycleRule(mockRule(), null), "BLOCK", recorded, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(),
                "client-hash", "NOPE");
        ReliveCycle saved = service.create(withSteps(bareCycle("later"), List.of(
                stepWithKey("s-in", null, "inbound"), outbound)), true);

        assertThat(saved.steps().get(1).fingerprint()).isNull();
        assertThat(saved.steps().get(1).fingerprintVersion()).isNull();
        String createdAt = saved.updatedAt();

        ReliveCycle stamped = service.fingerprint(saved.id());
        assertThat(stamped.steps().get(1).fingerprint()).isEqualTo(RequestFingerprint.of(recorded));
        assertThat(stamped.steps().get(1).fingerprintVersion()).isEqualTo(RequestFingerprint.VERSION);
        assertThat(stamped.updatedAt()).isNotEqualTo(createdAt);

        ReliveCycle again = service.fingerprint(saved.id());
        assertThat(again.updatedAt()).isEqualTo(stamped.updatedAt());
        assertThat(again.steps().get(1).fingerprint()).isEqualTo(stamped.steps().get(1).fingerprint());
        assertThat(stamped.fingerprintIndex().get("s-in").get(RequestFingerprint.of(recorded))).containsExactly("c-1");
    }

    @Test
    void fingerprintFillsAMissingIndexWithoutRehashing() {
        FrozenCall recorded = supplierCall("{\"a\":1}");
        ReliveCycle saved = service.create(withSteps(bareCycle("index"), List.of(
                stepWithKey("s-in", null, "inbound"),
                outbound("c-1", "s-in", "supplier", true, recorded))));
        String hash = saved.steps().get(1).fingerprint();
        cycleStore.save(new ReliveCycle(saved.id(), saved.name(), saved.description(), saved.steps(),
                saved.variables(), saved.cycleRules(), saved.globalRules(), saved.settings(), saved.noise(),
                saved.unexpectedCalls(), saved.createdAt(), saved.updatedAt(), saved.isTransient(), saved.lastRun(), null));

        ReliveCycle filled = service.fingerprint(saved.id());
        assertThat(filled.steps().get(1).fingerprint()).isEqualTo(hash);
        assertThat(filled.fingerprintIndex().get("s-in").get(hash)).containsExactly("c-1");
        assertThat(filled.updatedAt()).isNotEqualTo(saved.updatedAt());

        ReliveCycle again = service.fingerprint(saved.id());
        assertThat(again.updatedAt()).isEqualTo(filled.updatedAt());
        assertThat(again.fingerprintIndex()).isEqualTo(filled.fingerprintIndex());
    }

    @Test
    void rebuildRecomputesAStoredHashTheCheapStampWouldKeep() {
        FrozenCall recorded = supplierCall("{\"a\":1}");
        ReliveCycle saved = service.create(withSteps(bareCycle("rebuild"), List.of(
                stepWithKey("s-in", null, "inbound"),
                outbound("c-1", "s-in", "supplier", true, recorded))));
        String real = saved.steps().get(1).fingerprint();
        Step forged = saved.steps().get(1).withFingerprint("not-the-real-hash", RequestFingerprint.VERSION);
        cycleStore.save(new ReliveCycle(saved.id(), saved.name(), saved.description(),
                List.of(saved.steps().get(0), forged), saved.variables(), saved.cycleRules(), saved.globalRules(),
                saved.settings(), saved.noise(), saved.unexpectedCalls(), saved.createdAt(), saved.updatedAt(),
                saved.isTransient(), saved.lastRun(), saved.fingerprintIndex()));

        ReliveCycle kept = service.fingerprint(saved.id());
        assertThat(kept.steps().get(1).fingerprint()).isEqualTo("not-the-real-hash");
        assertThat(kept.updatedAt()).isEqualTo(saved.updatedAt());

        ReliveCycle rebuilt = service.fingerprint(saved.id(), true);
        assertThat(rebuilt.steps().get(1).fingerprint()).isEqualTo(real);
        assertThat(rebuilt.steps().get(1).fingerprintVersion()).isEqualTo(RequestFingerprint.VERSION);
        assertThat(rebuilt.fingerprintIndex().get("s-in").get(real)).containsExactly("c-1");
        assertThat(rebuilt.updatedAt()).isNotEqualTo(saved.updatedAt());
    }

    @Test
    void aCycleJsonWithoutTheIndexLoadsAsNull() throws Exception {
        JsonNode node = objectMapper.valueToTree(bareCycle("old"));
        ((com.fasterxml.jackson.databind.node.ObjectNode) node).remove("fingerprintIndex");
        ReliveCycle loaded = objectMapper.treeToValue(node, ReliveCycle.class);
        assertThat(loaded.fingerprintIndex()).isNull();
        assertThat(loaded.name()).isEqualTo("old");
    }

    @Test
    void renamingOrMovingAStepKeepsTheStoredHashUntilTheRequestChanges() {
        FrozenCall recorded = supplierCall("{\"a\":1}");
        ReliveCycle saved = service.create(withSteps(bareCycle("keep"), List.of(
                stepWithKey("s-in", null, "inbound"),
                stepWithKey("s-other", null, "inbound"),
                outbound("c-1", "s-in", "supplier", true, recorded))));
        String hash = saved.steps().get(2).fingerprint();

        Step moved = outbound("c-1", "s-other", "renamed", false, recorded);
        ReliveCycle renamed = service.update(saved.id(), withSteps(saved, List.of(
                saved.steps().get(0), saved.steps().get(1), moved)), saved.updatedAt(), null);
        assertThat(renamed.steps().get(2).fingerprint()).isEqualTo(hash);
        assertThat(renamed.steps().get(2).label()).isEqualTo("renamed");
        assertThat(renamed.steps().get(2).enabled()).isFalse();
        assertThat(renamed.fingerprintIndex()).isEmpty();

        ReliveCycle copy = service.duplicate(renamed.id(), null);
        assertThat(copy.steps().get(2).fingerprint()).isEqualTo(hash);

        FrozenCall edited = supplierCall("{\"a\":2}");
        ReliveCycle changed = service.update(renamed.id(), withSteps(renamed, List.of(
                renamed.steps().get(0), renamed.steps().get(1),
                outbound("c-1", "s-other", "renamed", false, edited))), renamed.updatedAt(), "body");
        assertThat(changed.steps().get(2).fingerprint()).isEqualTo(RequestFingerprint.of(edited));
        assertThat(changed.steps().get(2).fingerprint()).isNotEqualTo(hash);

        ReliveCycle restored = service.restore(renamed.id(), 1);
        assertThat(restored.steps().get(2).fingerprint()).isEqualTo(hash);
    }

    private FrozenCall supplierCall(String body) {
        return new FrozenCall("POST", "https://api.supplier.com/search?b=1&a=2",
                Map.of("Content-Type", "application/json", "Cookie", "a=b", "Client-Id", "NDC-Core"),
                body, 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");
    }

    private JsonNode mockRule() {
        var rule = objectMapper.createObjectNode();
        rule.putArray("actions").add(objectMapper.createObjectNode().put("type", "MOCK_RESPONSE").put("status", 200));
        return rule;
    }

    private Step outbound(String key, String parentKey, String label, boolean enabled, FrozenCall recording) {
        return new Step(key, parentKey, label, enabled, false, "outbound", "svc",
                new CycleRule(mockRule(), null), "BLOCK", recording, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
    }

    private Step stepWithKey(String key, String parentKey, String direction) {
        return new Step(key, parentKey, "label", true, false, direction, "svc",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", null, null,
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of(), null, null);
    }

    private Step withRule(Step step, JsonNode rule) {
        return new Step(step.key(), step.parentKey(), step.label(), step.enabled(), step.optional(),
                step.direction(), step.serviceName(), new CycleRule(rule, null), step.unattributed(),
                step.recording(), step.source(), step.extract(), step.assertions(), step.noise(), step.fingerprint(), step.fingerprintVersion());
    }

    private ReliveCycle withSteps(ReliveCycle base, List<Step> steps) {
        return new ReliveCycle(base.id(), base.name(), base.description(), steps, base.variables(),
                base.cycleRules(), base.globalRules(), base.settings(), base.noise(), base.unexpectedCalls(),
                base.createdAt(), base.updatedAt(), base.isTransient(), base.lastRun());
    }

    /** Minimal in-memory fake, not backend-relive's SQLite adapter under test elsewhere (T010). */
    static class FakeCycleStore implements ReliveCycleStorePort {
        final java.util.Map<String, ReliveCycle> byId = new java.util.LinkedHashMap<>();
        final java.util.Map<String, List<CycleVersion>> versionsByCycle = new java.util.LinkedHashMap<>();

        @Override public List<ReliveCycleSummary> listSummaries() {
            return byId.values().stream().map(c -> new ReliveCycleSummary(c.id(), c.name(), c.description(),
                    c.steps().size(), (int) c.steps().stream().filter(s -> s.parentKey() != null).count(),
                    0, c.cycleRules().size(), c.lastRun(), c.createdAt(), c.updatedAt(), c.isTransient())).toList();
        }
        @Override public Optional<ReliveCycle> findById(String id) { return Optional.ofNullable(byId.get(id)); }
        @Override public boolean existsById(String id) { return byId.containsKey(id); }
        @Override public ReliveCycle save(ReliveCycle cycle) { byId.put(cycle.id(), cycle); return cycle; }
        @Override public boolean deleteById(String id) { return byId.remove(id) != null; }
        @Override public void saveVersion(CycleVersion version, int keep) {
            versionsByCycle.computeIfAbsent(version.cycleId(), k -> new ArrayList<>()).add(0, version);
        }
        @Override public List<CycleVersion> listVersions(String cycleId) {
            return versionsByCycle.getOrDefault(cycleId, List.of());
        }
        @Override public Optional<CycleVersion> getVersion(String cycleId, int version) {
            return listVersions(cycleId).stream().filter(v -> v.version() == version).findFirst();
        }
        @Override public void pruneVersions(String cycleId, int keep) { }
    }

    static class FakeRunStore implements ReliveRunStorePort {
        final List<Run> runs = new ArrayList<>();
        @Override public Run create(Run run) { runs.add(run); return run; }
        @Override public Optional<Run> findById(String runId) { return runs.stream().filter(r -> r.id().equals(runId)).findFirst(); }
        @Override public List<Run> listByCycleId(String cycleId, int limit) { return runs.stream().filter(r -> r.cycleId().equals(cycleId)).toList(); }
        @Override public List<Run> findAllRunning() { return runs.stream().filter(r -> r.status() == RunStatus.RUNNING).toList(); }
        @Override public Run update(Run run) { return run; }
        @Override public void putStepResult(StepResult result) { }
        @Override public List<StepResult> listStepResults(String runId) { return List.of(); }
        @Override public void pruneRuns(String cycleId, int keep, long maxBytes) { }
        @Override public void deleteByCycleId(String cycleId) { runs.removeIf(r -> r.cycleId().equals(cycleId)); }
    }
}
