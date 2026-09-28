package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.out.GlobalRulesLookupPort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
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
    private static final Pattern VARIABLE_TOKEN = Pattern.compile("\\{\\{([A-Za-z][A-Za-z0-9_.-]*)}}");

    private final GlobalRulesLookupPort globalRulesLookup;

    public CycleValidator(GlobalRulesLookupPort globalRulesLookup) {
        this.globalRulesLookup = globalRulesLookup;
    }

    public List<ValidationFinding> validate(ReliveCycle cycle) {
        List<ValidationFinding> findings = new ArrayList<>();
        List<Step> steps = cycle.steps() == null ? List.of() : cycle.steps();

        checkMissingRecording(steps, findings);
        checkDuplicateSteps(steps, findings);
        checkNothingToRun(steps, findings);
        checkGlobalRuleGone(cycle, findings);
        checkRuleOverlap(cycle, findings);
        checkLiveExternal(steps, findings);
        checkMayBeUnattributed(cycle, findings);

        Set<String> declaredVariables = new HashSet<>();
        if (cycle.variables() != null) {
            cycle.variables().forEach(v -> declaredVariables.add(v.name()));
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
        if (!steps.isEmpty() && !anyEnabled) {
            findings.add(new ValidationFinding("BLOCK", "NOTHING_TO_RUN", null, "Every step is disabled - there is nothing for this run to do."));
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

    /** A step whose call rule has no enabled MOCK_RESPONSE/REPLACE_RESPONSE reaches a real host. */
    private void checkLiveExternal(List<Step> steps, List<ValidationFinding> findings) {
        for (Step step : steps) {
            if (!step.enabled() || step.parentKey() == null || step.callRule() == null) {
                continue;
            }
            JsonNode actions = step.callRule().rule() == null ? null : step.callRule().rule().get("actions");
            boolean answersWithoutHost = actions != null && actions.isArray()
                    && anyEnabledActionOfType(actions, "MOCK_RESPONSE");
            if (!answersWithoutHost) {
                findings.add(new ValidationFinding("WARN", "LIVE_EXTERNAL", step.key(),
                        "\"" + step.label() + "\" can reach a real external system."));
            }
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

    /** A Guided run has no per-call header to attribute by - every inbound call for the cycle's
     *  project(s) relies on in-flight uniqueness alone (research D1-D4). */
    private void checkMayBeUnattributed(ReliveCycle cycle, List<ValidationFinding> findings) {
        if (cycle.settings() != null && "GUIDED".equals(cycle.settings().defaultDriver())) {
            findings.add(new ValidationFinding("WARN", "MAY_BE_UNATTRIBUTED", null,
                    "Guided runs attribute inbound calls by timing alone - a second call to the same project while this run is active may be misattributed."));
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

    private void checkUnresolvedVariable(Set<String> declared, Set<String> used, List<ValidationFinding> findings) {
        for (String name : used) {
            if (!declared.contains(name)) {
                findings.add(new ValidationFinding("WARN", "UNRESOLVED_VARIABLE", null,
                        "{{" + name + "}} is used but never declared as a cycle variable."));
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
