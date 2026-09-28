package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepResult;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class CycleValidatorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** Mutable in-memory fake - only `findAllRunning` is ever exercised by CycleValidator; every
     *  other method is unused by these tests but must exist to satisfy the port. */
    private static final class FakeRunStore implements ReliveRunStorePort {
        final List<Run> running = new ArrayList<>();
        @Override public Run create(Run run) { throw new UnsupportedOperationException(); }
        @Override public Optional<Run> findById(String runId) { return Optional.empty(); }
        @Override public List<Run> listByCycleId(String cycleId, int limit) { return List.of(); }
        @Override public List<Run> findAllRunning() { return running; }
        @Override public Run update(Run run) { throw new UnsupportedOperationException(); }
        @Override public void putStepResult(StepResult result) { }
        @Override public List<StepResult> listStepResults(String runId) { return List.of(); }
        @Override public void pruneRuns(String cycleId, int keep, long maxBytes) { }
        @Override public void deleteByCycleId(String cycleId) { }
    }

    private final FakeRunStore runStore = new FakeRunStore();
    private final CycleValidator validator = new CycleValidator(new GlobalRulesLookupPort() {
        @Override public List<com.fathy.alfred.backend.relive.application.port.out.GlobalRuleRef> list() { return List.of(); }
        @Override public boolean exists(String id) { return "r-exists".equals(id); }
    }, runStore);

    private FrozenCall recording(String url) {
        return new FrozenCall("POST", url, Collections.emptyMap(), "{}", 200, Collections.emptyMap(), "{}",
                "2026-09-27T10:00:00Z", 100, null, null, "odeysys", "outbound");
    }

    private JsonNode ruleDoc(String... extra) throws Exception {
        StringBuilder actions = new StringBuilder("[");
        for (int i = 0; i < extra.length; i++) {
            if (i > 0) actions.append(',');
            actions.append(extra[i]);
        }
        actions.append(']');
        return objectMapper.readTree("{\"name\":\"r\",\"match\":{},\"actions\":" + actions + "}");
    }

    private Step step(String key, String parentKey, FrozenCall rec, JsonNode rule) {
        return new Step(key, parentKey, "label-" + key, true, false, parentKey == null ? "inbound" : "outbound",
                "odeysys", new CycleRule(rule, null), "BLOCK", rec, new StepSource(key, null, "outbound"),
                objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
    }

    private ReliveCycle cycle(List<Step> steps) {
        return new ReliveCycle("c-1", "Book flow", null, steps, List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
    }

    private boolean has(List<ValidationFinding> findings, String code) {
        return findings.stream().anyMatch(f -> f.code().equals(code));
    }

    @Test
    void missingRecordingIsBlocking() {
        Step step = new Step("s-1", null, "x", true, false, "inbound", "odeysys",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", null,
                new StepSource("s-1", null, "outbound"), objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
        List<ValidationFinding> findings = validator.validate(cycle(List.of(step)));
        assertThat(has(findings, "MISSING_RECORDING")).isTrue();
        assertThat(findings.stream().filter(f -> f.code().equals("MISSING_RECORDING")).findFirst().get().severity()).isEqualTo("BLOCK");
    }

    @Test
    void duplicateStepKeysAreBlocking() throws Exception {
        JsonNode rule = ruleDoc();
        Step a = step("dup", null, recording("https://app.local/x"), rule);
        Step b = step("dup", null, recording("https://app.local/y"), rule);
        assertThat(has(validator.validate(cycle(List.of(a, b))), "DUPLICATE_STEP")).isTrue();
    }

    @Test
    void everyStepDisabledIsNothingToRun() throws Exception {
        JsonNode rule = ruleDoc();
        Step disabled = new Step("s-1", null, "x", false, false, "inbound", "odeysys",
                new CycleRule(rule, null), "BLOCK", recording("https://app.local/x"),
                new StepSource("s-1", null, "outbound"), objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
        assertThat(has(validator.validate(cycle(List.of(disabled))), "NOTHING_TO_RUN")).isTrue();
    }

    @Test
    void emptyCycleCannotStart() {
        List<ValidationFinding> findings = validator.validate(cycle(List.of()));
        assertThat(findings).anySatisfy(finding -> {
            assertThat(finding.code()).isEqualTo("NOTHING_TO_RUN");
            assertThat(finding.severity()).isEqualTo("BLOCK");
        });
    }

    @Test
    void selectedGlobalRuleThatNoLongerExistsWarns() throws Exception {
        ReliveCycle cycle = new ReliveCycle("c-1", "x", null, List.of(step("s-1", null, recording("https://app.local/x"), ruleDoc())),
                List.of(), List.of(), new GlobalRulesSelection("SELECTED", List.of("r-gone")),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()), List.of(),
                new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        assertThat(has(validator.validate(cycle), "GLOBAL_RULE_GONE")).isTrue();
    }

    @Test
    void twoCycleRulesWithTheSameMatchOverlap() throws Exception {
        JsonNode ruleA = objectMapper.readTree("{\"name\":\"A\",\"match\":{\"host\":\"x\"},\"actions\":[]}");
        JsonNode ruleB = objectMapper.readTree("{\"name\":\"B\",\"match\":{\"host\":\"x\"},\"actions\":[]}");
        ReliveCycle cycle = new ReliveCycle("c-1", "x", null, List.of(),
                List.of(), List.of(new CycleRule(ruleA, null), new CycleRule(ruleB, null)),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()), List.of(),
                new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        assertThat(has(validator.validate(cycle), "RULE_OVERLAP")).isTrue();
    }

    @Test
    void childStepWithNoEnabledMockReachesTheRealHost() throws Exception {
        JsonNode liveRule = ruleDoc(); // no MOCK_RESPONSE action at all
        Step child = step("c-1", "s-1", recording("https://api.supplier-a.com/x"), liveRule);
        assertThat(has(validator.validate(cycle(List.of(child))), "LIVE_EXTERNAL")).isTrue();
    }

    @Test
    void guidedDriverMayBeUnattributed() {
        ReliveCycle cycle = new ReliveCycle("c-1", "x", null, List.of(), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "GUIDED", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        assertThat(has(validator.validate(cycle), "MAY_BE_UNATTRIBUTED")).isTrue();
    }

    @Test
    void guidedDriverBlocksWhenAnotherCycleAlreadyHasAGuidedRunForTheSameProject() {
        Step inbound = new Step("s-1", null, "x", true, false, "inbound", "odeysys",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recording("https://app.local/x"),
                new StepSource("s-1", null, "outbound"), objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
        ReliveCycle guidedCycle = new ReliveCycle("c-1", "x", null, List.of(inbound), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "GUIDED", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);

        ReliveCycle busyCycleDefinition = new ReliveCycle("c-2", "other", null, List.of(inbound), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "GUIDED", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        runStore.running.add(new Run("run-2", "c-2", "GUIDED", RunStatus.RUNNING, "t0", null, busyCycleDefinition,
                null, List.of(), List.of(), null, null, List.of(), List.of()));

        List<ValidationFinding> findings = validator.validate(guidedCycle);
        assertThat(has(findings, "GUIDED_PROJECT_BUSY")).isTrue();
        assertThat(findings.stream().filter(f -> f.code().equals("GUIDED_PROJECT_BUSY")).findFirst().get().severity()).isEqualTo("BLOCK");
    }

    @Test
    void guidedDriverIsNotBusyWhenTheRunningGuidedRunIsItsOwn() {
        Step inbound = new Step("s-1", null, "x", true, false, "inbound", "odeysys",
                new CycleRule(objectMapper.createObjectNode(), null), "BLOCK", recording("https://app.local/x"),
                new StepSource("s-1", null, "outbound"), objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
        ReliveCycle guidedCycle = new ReliveCycle("c-1", "x", null, List.of(inbound), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "GUIDED", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        runStore.running.add(new Run("run-1", "c-1", "GUIDED", RunStatus.RUNNING, "t0", null, guidedCycle,
                null, List.of(), List.of(), null, null, List.of(), List.of()));

        assertThat(has(validator.validate(guidedCycle), "GUIDED_PROJECT_BUSY")).isFalse();
    }

    @Test
    void unresolvedVariableIsUsedButNeverDeclared() throws Exception {
        JsonNode rule = ruleDoc("{\"type\":\"SET_REQUEST_HEADER\",\"name\":\"X\",\"value\":\"{{token}}\",\"enabled\":true}");
        Step step = step("s-1", null, recording("https://app.local/x"), rule);
        assertThat(has(validator.validate(cycle(List.of(step))), "UNRESOLVED_VARIABLE")).isTrue();
    }

    @Test
    void unusedVariableIsDeclaredButNeverReferenced() throws Exception {
        ReliveCycle cycle = new ReliveCycle("c-1", "x", null, List.of(step("s-1", null, recording("https://app.local/x"), ruleDoc())),
                List.of(new CycleVariable("unused", "v", false, null)), List.of(),
                new GlobalRulesSelection("NONE", List.of()), new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()), List.of(),
                new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
        assertThat(has(validator.validate(cycle), "UNUSED_VARIABLE")).isTrue();
    }

    @Test
    void orderDependencyWhenAStepUsesAVariableOnlyALaterStepExtracts() throws Exception {
        JsonNode extractLater = objectMapper.readTree("[{\"from\":\"JSON\",\"path\":\"$.id\",\"as\":\"searchId\",\"missing\":\"SKIP\"}]");
        JsonNode usesEarly = ruleDoc("{\"type\":\"SET_QUERY_PARAM\",\"name\":\"sid\",\"value\":\"{{searchId}}\",\"enabled\":true}");

        Step early = new Step("s-early", null, "early", true, false, "inbound", "odeysys",
                new CycleRule(usesEarly, null), "BLOCK", recording("https://app.local/x"),
                new StepSource("s-early", null, "outbound"), objectMapper.createArrayNode(), objectMapper.createArrayNode(), List.of());
        Step later = new Step("s-later", null, "later", true, false, "inbound", "odeysys",
                new CycleRule(ruleDoc(), null), "BLOCK", recording("https://app.local/y"),
                new StepSource("s-later", null, "outbound"), (JsonNode) extractLater, objectMapper.createArrayNode(), List.of());

        assertThat(has(validator.validate(cycle(List.of(early, later))), "ORDER_DEPENDENCY")).isTrue();
    }
}
