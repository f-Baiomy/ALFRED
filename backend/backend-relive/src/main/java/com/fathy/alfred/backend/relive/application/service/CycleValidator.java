package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.ValidationFinding;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pre-run validation (FR-017) - richer than the save-time checks in {@link ReliveCyclesService}
 * (which only rejects a definition the engine could not even carry out). This is the authoritative
 * side; {@code relive-validate.ts} mirrors it for instant feedback while editing, both against the
 * same codes (data-model.md "ValidationFinding").
 */
public class CycleValidator {

    /** Mirrors frontend/src/app/shared/utils/variable-tokens.ts's VARIABLE_TOKEN exactly. */
    private static final Pattern VARIABLE_TOKEN = Pattern.compile("\\{\\{\\$\\.([A-Za-z][A-Za-z0-9_.-]*)}}");

    private final GlobalRulesLookupPort globalRulesLookup;
    private final ReliveRunStorePort runStore;

    public CycleValidator(GlobalRulesLookupPort globalRulesLookup, ReliveRunStorePort runStore) {
        this.globalRulesLookup = globalRulesLookup;
        this.runStore = runStore;
    }

    public List<ValidationFinding> validate(ReliveCycle cycle) {
        return validate(cycle, cycle.settings() == null ? null : cycle.settings().defaultDriver());
    }

    /** {@code driver}: the one this run will use - the pre-run dialog may choose Guided for a cycle
     *  whose default is Automatic, and the Guided checks must apply then too (review B18). */
    public List<ValidationFinding> validate(ReliveCycle cycle, String driver) {
        boolean guided = "GUIDED".equals(driver);
        List<ValidationFinding> findings = new ArrayList<>();
        List<Step> steps = cycle.steps() == null ? List.of() : cycle.steps();

        checkMissingRecording(steps, findings);
        checkDuplicateSteps(steps, findings);
        checkNothingToRun(steps, findings);
        checkGlobalRuleGone(cycle, findings);
        checkRuleOverlap(cycle, findings);
        checkLiveExternal(cycle, steps, findings);
        checkMayBeUnattributed(steps, guided, findings);
        checkGuidedProjectBusy(cycle, guided, findings);
        checkGlobalCycleOverlap(cycle, findings);
        checkSameRecordingTwice(steps, findings);

        Set<String> declaredVariables = new HashSet<>();
        if (cycle.variables() != null) {
            cycle.variables().forEach(v -> declaredVariables.add(v.name()));
        }
        for (Step step : steps) {
            if (step.extract() != null && step.extract().isArray()) {
                step.extract().forEach(extract -> {
                    if (extract.path("as").isTextual()) declaredVariables.add(extract.path("as").asText());
                });
            }
            if (step.callRule() != null) collectReliveDeclarations(step.callRule().rule(), declaredVariables);
        }
        if (cycle.cycleRules() != null) {
            cycle.cycleRules().forEach(rule -> collectReliveDeclarations(rule.rule(), declaredVariables));
        }
        if (cycle.unexpectedCalls() != null && cycle.unexpectedCalls().rules() != null) {
            cycle.unexpectedCalls().rules().forEach(rule -> collectReliveDeclarations(rule.rule(), declaredVariables));
        }
        Set<String> usedVariables = new HashSet<>();
        collectVariableUsages(cycle, usedVariables);
        checkUnresolvedVariable(declaredVariables, usedVariables, findings);
        checkUnusedVariable(declaredVariables, usedVariables, findings);
        checkOrderDependency(steps, findings);

        return findings;
    }

    private void checkMissingRecording(List<Step> steps, List<ValidationFinding> findings) {
        for (Step step : steps) {
            if (step.recording() == null) {
                findings.add(new ValidationFinding("BLOCK", "MISSING_RECORDING", step.key(),
                        "\"" + step.label() + "\" has no recording to replay or compare against."));
            }
        }
    }

    private void checkDuplicateSteps(List<Step> steps, List<ValidationFinding> findings) {
        Set<String> seen = new HashSet<>();
        for (Step step : steps) {
            if (!seen.add(step.key())) {
                findings.add(new ValidationFinding("BLOCK", "DUPLICATE_STEP", step.key(),
                        "Two steps share the key \"" + step.key() + "\"."));
            }
        }
    }

    private void checkNothingToRun(List<Step> steps, List<ValidationFinding> findings) {
        boolean anyEnabled = steps.stream().anyMatch(Step::enabled);
        if (!anyEnabled) {
            findings.add(new ValidationFinding("BLOCK", "NOTHING_TO_RUN", null,
                    steps.isEmpty() ? "Add calls before starting a run." : "Every step is disabled - there is nothing for this run to do."));
        }
    }

    private void checkGlobalRuleGone(ReliveCycle cycle, List<ValidationFinding> findings) {
        if (cycle.globalRules() == null || !"SELECTED".equals(cycle.globalRules().mode())) {
            return;
        }
        for (String id : cycle.globalRules().selectedIds()) {
            if (!globalRulesLookup.exists(id)) {
                findings.add(new ValidationFinding("WARN", "GLOBAL_RULE_GONE", null,
                        "A selected global rule (" + id + ") no longer exists."));
            }
        }
    }

    /** Two cycle rules whose match documents are textually identical - the second can never be
     *  reached first, since rules run in file order within a tier and both are tier CYCLE. */
    private void checkRuleOverlap(ReliveCycle cycle, List<ValidationFinding> findings) {
        List<CycleRule> rules = cycle.cycleRules() == null ? List.of() : cycle.cycleRules();
        Map<String, String> seenMatchToName = new HashMap<>();
        for (CycleRule rule : rules) {
            if (rule.rule() != null && rule.rule().path("enabled").isBoolean()
                    && !rule.rule().path("enabled").asBoolean()) {
                continue;
            }
            JsonNode match = rule.rule() == null ? null : rule.rule().get("match");
            if (match == null) {
                continue;
            }
            String key = match.toString();
            String earlier = seenMatchToName.putIfAbsent(key, textOrEmpty(rule.rule(), "name"));
            if (earlier != null) {
                findings.add(new ValidationFinding("WARN", "RULE_OVERLAP", null,
                        "Cycle rules \"" + earlier + "\" and \"" + textOrEmpty(rule.rule(), "name") + "\" match the same thing - only the first ever runs."));
            }
        }
    }

    /** Every way the run can reach a real external system (FR-016), by the same walk as the
     *  browser's reachesHost: each enabled path through the call rule, IF branches and otherwise
     *  included - so "Call live" on a differing request and Rewrite URL count, a host the cycle marks
     *  internal does not - plus unexpected-call and unattributed policies that send to the real system. */
    private void checkLiveExternal(ReliveCycle cycle, List<Step> steps, List<ValidationFinding> findings) {
        List<String> internalHosts = cycle.settings() == null || cycle.settings().internalHosts() == null
                ? List.of() : cycle.settings().internalHosts();
        for (Step step : steps) {
            if (!step.enabled() || step.parentKey() == null || step.callRule() == null) {
                continue;
            }
            String host = hostOf(step);
            if (internalHosts.stream().anyMatch(suffix -> host.equals(suffix) || host.endsWith(suffix))) {
                continue;
            }
            JsonNode actions = step.callRule().rule() == null ? null : step.callRule().rule().get("actions");
            if (reachesHost(actions == null ? List.of() : toList(actions))) {
                findings.add(new ValidationFinding("WARN", "LIVE_EXTERNAL", step.key(),
                        "\"" + step.label() + "\" can reach a real external system (" + host + ")."));
            }
            if (step.enabled() && "SEND_REAL".equals(step.unattributed())) {
                findings.add(new ValidationFinding("WARN", "LIVE_EXTERNAL", step.key(),
                        "\"" + step.label() + "\": a matching call ALFRED can't tie to this run is sent to the real system."));
            }
        }
        var unexpected = cycle.unexpectedCalls();
        if (unexpected != null && ("SEND_REAL".equals(unexpected.policy())
                || ("RULES".equals(unexpected.policy()) && "SEND_REAL".equals(unexpected.fallback())))) {
            findings.add(new ValidationFinding("WARN", "LIVE_EXTERNAL", null,
                    "Unexpected outbound calls are sent to the real system."));
        }
    }

    private static final java.util.Set<String> TERMINAL = java.util.Set.of(
            "ABORT_REQUEST", "MOCK_RESPONSE", "SIMULATE_FAILURE", "ANSWER_WITH_RECORDED_CALL", "ANSWER_WITH_FILE");

    static boolean reachesHost(List<JsonNode> actions) {
        return reachesHost(actions, 0);
    }

    /** {@code nestedCount}: how many of the first {@code actions} come from inside an IF branch. A
     *  checkpoint (a top-level pause) carries on with the rule once released or timed out; the
     *  "Ask me" pause of the request-differs branch ends in a failure unless someone says yes, so
     *  only that one stops the call from reaching the host (T082). */
    private static boolean reachesHost(List<JsonNode> actions, int nestedCount) {
        for (int i = 0; i < actions.size(); i++) {
            JsonNode action = actions.get(i);
            if (action.path("enabled").isBoolean() && !action.path("enabled").asBoolean()) {
                continue;
            }
            String type = action.path("type").asText();
            if (TERMINAL.contains(type) || ("PAUSE_REQUEST".equals(type) && i < nestedCount)) {
                return false;
            }
            if ("SEND_TO_HOST".equals(type) || "REWRITE_URL".equals(type)) {
                return true;
            }
            if ("IF_REQUEST".equals(type)) {
                List<JsonNode> rest = actions.subList(i + 1, actions.size());
                int restNested = Math.max(0, nestedCount - (i + 1));
                for (JsonNode branch : action.path("branches")) {
                    List<JsonNode> branchActions = toList(branch.path("actions"));
                    if (reachesHost(concat(branchActions, rest), branchActions.size() + restNested)) {
                        return true;
                    }
                }
                List<JsonNode> otherwise = toList(action.path("otherwise"));
                return reachesHost(concat(otherwise, rest), otherwise.size() + restNested);
            }
        }
        return true;
    }

    private static List<JsonNode> toList(JsonNode array) {
        List<JsonNode> out = new ArrayList<>();
        if (array != null && array.isArray()) {
            array.forEach(out::add);
        }
        return out;
    }

    private static List<JsonNode> concat(List<JsonNode> first, List<JsonNode> rest) {
        List<JsonNode> out = new ArrayList<>(first);
        out.addAll(rest);
        return out;
    }

    private static String hostOf(Step step) {
        if (step.recording() == null || step.recording().url() == null) {
            return "";
        }
        try {
            String host = java.net.URI.create(step.recording().url()).getHost();
            return host == null ? "" : host.toLowerCase();
        } catch (IllegalArgumentException e) {
            return "";
        }
    }

    private static boolean anyEnabledActionOfType(JsonNode actions, String type) {
        for (JsonNode action : actions) {
            JsonNode enabled = action.get("enabled");
            boolean isEnabled = enabled == null || enabled.isNull() || enabled.asBoolean(true);
            if (isEnabled && type.equals(textOrEmpty(action, "type"))) {
                return true;
            }
        }
        return false;
    }

    /** FR-049a: the REPLAY children whose calls ALFRED may not be able to tie to this run. In a
     *  Guided run nothing carries the run's tag, so every REPLAY child is attributed by timing;
     *  each is listed with the choice that applies when that fails. */
    private void checkMayBeUnattributed(List<Step> steps, boolean guided, List<ValidationFinding> findings) {
        if (!guided) {
            return;
        }
        for (Step step : steps) {
            if (!step.enabled() || step.parentKey() == null || step.callRule() == null
                    || !"REPLAY".equals(RunSnapshotBuilder.modeOf(step.callRule().rule()))) {
                continue;
            }
            findings.add(new ValidationFinding("WARN", "MAY_BE_UNATTRIBUTED", step.key(),
                    "\"" + step.label() + "\" is matched by timing in a Guided run; if ALFRED can't tell it is this run's: "
                            + (step.unattributed() == null ? "BLOCK" : step.unattributed()) + "."));
        }
    }

    /** T077: a Guided run attributes an inbound call to itself only when it is the sole active
     *  Guided run for that project (proxy/relive.py's own project-uniqueness rule, research D2). A
     *  cycle whose own driver is GUIDED and whose projects overlap another cycle's already-RUNNING
     *  Guided run would therefore have its calls misattributed the moment it started - this is a
     *  BLOCK, not the timing-only WARN checkMayBeUnattributed gives every Guided cycle. */
    private void checkGuidedProjectBusy(ReliveCycle cycle, boolean guided, List<ValidationFinding> findings) {
        if (!guided) {
            return;
        }
        Set<String> thisProjects = RunSnapshotBuilder.projectsOf(cycle);
        if (thisProjects.isEmpty()) {
            return;
        }
        for (Run run : runStore.findAllRunning()) {
            if (run.cycleId().equals(cycle.id()) || !"GUIDED".equals(run.driver()) || run.definition() == null) {
                continue;
            }
            Set<String> busyProjects = RunSnapshotBuilder.projectsOf(run.definition());
            busyProjects.retainAll(thisProjects);
            for (String project : busyProjects) {
                findings.add(new ValidationFinding("BLOCK", "GUIDED_PROJECT_BUSY", null,
                        "\"" + project + "\" already has a Guided run in progress (from another cycle) - inbound calls could be attributed to the wrong run."));
            }
        }
    }

    /** FR-017/FR-028: a participating GLOBAL rule and a CYCLE rule that could both affect one call.
     *  Two matches overlap unless their hosts, or their path tests, plainly differ. */
    private void checkGlobalCycleOverlap(ReliveCycle cycle, List<ValidationFinding> findings) {
        if (cycle.globalRules() == null || "NONE".equals(cycle.globalRules().mode()) || cycle.cycleRules() == null) {
            return;
        }
        Set<String> selected = new HashSet<>(cycle.globalRules().selectedIds());
        List<com.fathy.alfred.backend.relive.application.port.out.GlobalRuleRef> globals = globalRulesLookup.list().stream()
                .filter(g -> g.enabled() && ("ALL".equals(cycle.globalRules().mode()) || selected.contains(g.id())))
                .toList();
        for (CycleRule rule : cycle.cycleRules()) {
            JsonNode doc = rule.rule();
            if (doc == null || (doc.path("enabled").isBoolean() && !doc.path("enabled").asBoolean())) {
                continue;
            }
            for (var global : globals) {
                if (matchesOverlap(doc.get("match"), global.match())) {
                    findings.add(new ValidationFinding("WARN", "RULE_OVERLAP", null,
                            "CYCLE rule \"" + textOrEmpty(doc, "name") + "\" and GLOBAL rule \"" + global.name()
                                    + "\" can both affect the same call - CYCLE rules run first, then GLOBAL."));
                }
            }
        }
    }

    static boolean matchesOverlap(JsonNode a, JsonNode b) {
        if (a == null || b == null || a.isNull() || b.isNull()) {
            return true;
        }
        String hostA = a.path("host").asText("");
        String hostB = b.path("host").asText("");
        if (!hostA.isEmpty() && !hostB.isEmpty() && !hostA.contains("*") && !hostB.contains("*")
                && !hostA.equalsIgnoreCase(hostB)) {
            return false;
        }
        String pathA = a.path("pathContains").asText("");
        String pathB = b.path("pathContains").asText("");
        return pathA.isEmpty() || pathB.isEmpty() || pathA.contains(pathB) || pathB.contains(pathA);
    }

    /** Edge case "the same recorded call added twice": allowed, but flagged so it is intentional. */
    private void checkSameRecordingTwice(List<Step> steps, List<ValidationFinding> findings) {
        Map<String, String> firstLabel = new HashMap<>();
        for (Step step : steps) {
            if (step.source() == null || step.source().callId() == null) {
                continue;
            }
            String earlier = firstLabel.putIfAbsent(step.source().callId() + "|" + step.parentKey(), step.label());
            if (earlier != null) {
                findings.add(new ValidationFinding("WARN", "DUPLICATE_STEP", step.key(),
                        "\"" + step.label() + "\" replays the same recorded call as an earlier step - fine if intended."));
            }
        }
    }

    private void collectVariableUsages(ReliveCycle cycle, Set<String> into) {
        if (cycle.steps() != null) {
            for (Step step : cycle.steps()) {
                if (step.callRule() != null) {
                    collectTokens(step.callRule().rule(), into);
                }
            }
        }
        if (cycle.cycleRules() != null) {
            for (CycleRule rule : cycle.cycleRules()) {
                collectTokens(rule.rule(), into);
            }
        }
        if (cycle.unexpectedCalls() != null && cycle.unexpectedCalls().rules() != null) {
            for (CycleRule rule : cycle.unexpectedCalls().rules()) {
                collectTokens(rule.rule(), into);
            }
        }
    }

    private void collectTokens(JsonNode node, Set<String> into) {
        if (node == null) {
            return;
        }
        Matcher matcher = VARIABLE_TOKEN.matcher(node.toString());
        while (matcher.find()) {
            into.add(matcher.group(1));
        }
    }

    private void collectReliveDeclarations(JsonNode node, Set<String> into) {
        if (node == null || node.isNull()) return;
        if (node.isArray()) {
            node.forEach(child -> collectReliveDeclarations(child, into));
        } else if (node.isObject()) {
            if ("RELIVE".equals(node.path("scope").asText())
                    && node.path("name").isTextual()
                    && node.path("name").asText().matches("[A-Za-z][A-Za-z0-9_]*")) {
                into.add(node.path("name").asText());
            }
            node.elements().forEachRemaining(child -> collectReliveDeclarations(child, into));
        }
    }

    private void checkUnresolvedVariable(Set<String> declared, Set<String> used, List<ValidationFinding> findings) {
        for (String name : used) {
            if (!declared.contains(name)) {
                findings.add(new ValidationFinding("WARN", "UNRESOLVED_VARIABLE", null,
                        "{{$." + name + "}} is used but never defined in this Relive cycle."));
            }
        }
    }

    private void checkUnusedVariable(Set<String> declared, Set<String> used, List<ValidationFinding> findings) {
        for (String name : declared) {
            if (!used.contains(name)) {
                findings.add(new ValidationFinding("WARN", "UNUSED_VARIABLE", null,
                        "The variable \"" + name + "\" is declared but never used."));
            }
        }
    }

    /** A step uses {{name}} where name is only ever extracted by a LATER step - it will always be
     *  unresolved the first time this run reaches it. */
    private void checkOrderDependency(List<Step> steps, List<ValidationFinding> findings) {
        Map<String, Integer> extractedAt = new HashMap<>();
        for (int i = 0; i < steps.size(); i++) {
            Step step = steps.get(i);
            if (step.extract() == null || !step.extract().isArray()) {
                continue;
            }
            for (JsonNode extraction : step.extract()) {
                String producedName = textOrEmpty(extraction, "as");
                if (!producedName.isEmpty()) {
                    extractedAt.putIfAbsent(producedName, i);
                }
            }
        }
        for (int i = 0; i < steps.size(); i++) {
            Step step = steps.get(i);
            if (step.callRule() == null) {
                continue;
            }
            Set<String> usedHere = new HashSet<>();
            collectTokens(step.callRule().rule(), usedHere);
            for (String name : usedHere) {
                Integer producedIndex = extractedAt.get(name);
                if (producedIndex != null && producedIndex >= i) {
                    findings.add(new ValidationFinding("WARN", "ORDER_DEPENDENCY", step.key(),
                            "\"" + step.label() + "\" uses {{" + name + "}}, which is only extracted by a later or the same step."));
                }
            }
        }
    }

    private static String textOrEmpty(JsonNode node, String field) {
        if (node == null) {
            return "";
        }
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? "" : value.asText("");
    }
}
