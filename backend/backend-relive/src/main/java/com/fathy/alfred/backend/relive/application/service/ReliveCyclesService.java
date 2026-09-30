package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.relive.application.port.in.CycleInUseException;
import com.fathy.alfred.backend.relive.application.port.in.CycleValidationException;
import com.fathy.alfred.backend.relive.application.port.in.ManageCycleVersionsUseCase;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.StaleCycleException;
import com.fathy.alfred.backend.relive.application.port.out.ReliveCycleStorePort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveNotificationPort;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.port.out.RuleValidationPort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.CycleVersion;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;
import com.fathy.alfred.backend.relive.domain.model.ReliveLimits;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/** Implements cycle CRUD, its validation-on-save rules and its saved versions. */
@Service
public class ReliveCyclesService implements ManageReliveCyclesUseCase, ManageCycleVersionsUseCase {

    private static final Pattern VARIABLE_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*");
    private static final int KEEP_VERSIONS = 10;

    private final ReliveCycleStorePort cycleStore;
    private final ReliveRunStorePort runStore;
    private final RuleValidationPort ruleValidation;
    private final ReliveNotificationPort notifications;

    public ReliveCyclesService(ReliveCycleStorePort cycleStore, ReliveRunStorePort runStore,
                                RuleValidationPort ruleValidation, ReliveNotificationPort notifications) {
        this.cycleStore = cycleStore;
        this.runStore = runStore;
        this.ruleValidation = ruleValidation;
        this.notifications = notifications;
    }

    @Override
    public List<ReliveCycleSummary> list() {
        return cycleStore.listSummaries();
    }

    @Override
    public Optional<ReliveCycle> get(String id) {
        return cycleStore.findById(id);
    }

    @Override
    public ReliveCycle create(ReliveCycle cycle) {
        return create(cycle, false);
    }

    @Override
    public ReliveCycle create(ReliveCycle cycle, boolean deferFingerprint) {
        return createInternal(cycle, false, deferFingerprint);
    }

    @Override
    public ReliveCycle createTransient(ReliveCycle cycle) {
        return createTransient(cycle, false);
    }

    @Override
    public ReliveCycle createTransient(ReliveCycle cycle, boolean deferFingerprint) {
        return createInternal(cycle, true, deferFingerprint);
    }

    @Override
    public ReliveCycle fingerprint(String id) {
        return fingerprint(id, false);
    }

    @Override
    public ReliveCycle fingerprint(String id, boolean rebuild) {
        ReliveCycle existing = cycleStore.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + id + " does not exist"));
        // Hashes are already current. A missing index is filled from those hashes, with no body read.
        if (!rebuild && !StepFingerprints.missing(existing.steps())) {
            if (existing.fingerprintIndex() != null) {
                return existing;
            }
            return storeFingerprints(existing, existing.steps(), StepFingerprints.indexes(existing.steps()));
        }
        List<Step> stamped = StepFingerprints.maintain(existing.steps(), rebuild ? List.of() : existing.steps());
        Map<String, Map<String, List<String>>> index = StepFingerprints.indexes(stamped);
        if (stamped.equals(existing.steps()) && index.equals(existing.fingerprintIndex())) {
            return existing;
        }
        return storeFingerprints(existing, stamped, index);
    }

    private ReliveCycle storeFingerprints(ReliveCycle existing, List<Step> steps,
                                           Map<String, Map<String, List<String>>> index) {
        String now = Instant.now().toString();
        ReliveCycle toSave = new ReliveCycle(existing.id(), existing.name(), existing.description(), steps,
                existing.variables(), existing.cycleRules(), existing.globalRules(), existing.settings(),
                existing.noise(), existing.unexpectedCalls(), existing.createdAt(), now,
                existing.isTransient(), existing.lastRun(), index);
        ReliveCycle saved = cycleStore.save(toSave);
        notifications.cycleChanged();
        return saved;
    }

    private ReliveCycle createInternal(ReliveCycle cycle, boolean isTransient, boolean deferFingerprint) {
        validate(cycle);
        String now = Instant.now().toString();
        List<Step> steps = deferFingerprint
                ? StepFingerprints.cleared(cycle.steps())
                : StepFingerprints.maintain(cycle.steps(), List.of());
        ReliveCycle toSave = new ReliveCycle(
                cycle.id() == null ? UUID.randomUUID().toString() : cycle.id(),
                cycle.name(), cycle.description(), steps,
                cycle.variables(), cycle.cycleRules(),
                cycle.globalRules(), cycle.settings(), cycle.noise(), cycle.unexpectedCalls(),
                now, now, isTransient, cycle.lastRun(), StepFingerprints.indexes(steps));
        ReliveCycle saved = cycleStore.save(toSave);
        notifications.cycleChanged();
        return saved;
    }

    @Override
    public ReliveCycle update(String id, ReliveCycle cycle, String ifMatch, String reason) {
        ReliveCycle existing = cycleStore.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + id + " does not exist"));
        if (ifMatch != null && !ifMatch.equals(existing.updatedAt())) {
            throw new StaleCycleException(id);
        }
        validate(cycle);
        if (reason != null && !reason.isBlank()) {
            cycleStore.saveVersion(new CycleVersion(id, nextVersionNumber(id), existing.updatedAt(), reason, existing), KEEP_VERSIONS);
        }
        String now = Instant.now().toString();
        List<Step> stamped = StepFingerprints.maintain(cycle.steps(), existing.steps());
        ReliveCycle toSave = new ReliveCycle(id, cycle.name(), cycle.description(), stamped,
                cycle.variables(), cycle.cycleRules(), cycle.globalRules(), cycle.settings(), cycle.noise(),
                cycle.unexpectedCalls(), existing.createdAt(), now, existing.isTransient(), existing.lastRun(),
                StepFingerprints.indexes(stamped));
        ReliveCycle saved = cycleStore.save(toSave);
        notifications.cycleChanged();
        return saved;
    }

    private int nextVersionNumber(String cycleId) {
        List<CycleVersion> existing = cycleStore.listVersions(cycleId);
        return existing.isEmpty() ? 1 : existing.get(0).version() + 1;
    }

    @Override
    public ReliveCycle duplicate(String id, String name) {
        ReliveCycle existing = cycleStore.findById(id)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + id + " does not exist"));
        String now = Instant.now().toString();
        String copyName = (name == null || name.isBlank()) ? existing.name() + " (copy)" : name;
        List<Step> stamped = StepFingerprints.maintain(existing.steps(), existing.steps());
        ReliveCycle copy = new ReliveCycle(UUID.randomUUID().toString(), copyName,
                existing.description(), stamped,
                existing.variables(), existing.cycleRules(),
                existing.globalRules(), existing.settings(), existing.noise(), existing.unexpectedCalls(),
                now, now, false, null, StepFingerprints.indexes(stamped));
        ReliveCycle saved = cycleStore.save(copy);
        notifications.cycleChanged();
        return saved;
    }

    @Override
    public void delete(String id) {
        boolean hasRunningRun = runStore.listByCycleId(id, ReliveLimits.MAX_LIST_LIMIT).stream()
                .anyMatch(r -> r.status() == RunStatus.RUNNING);
        if (hasRunningRun) {
            throw new CycleInUseException(id);
        }
        runStore.deleteByCycleId(id);
        cycleStore.deleteById(id);
        notifications.cycleChanged();
    }

    @Override
    public List<CycleVersion> list(String cycleId) {
        return cycleStore.listVersions(cycleId);
    }

    @Override
    public ReliveCycle restore(String cycleId, int version) {
        CycleVersion found = cycleStore.getVersion(cycleId, version)
                .orElseThrow(() -> new IllegalArgumentException("No version " + version + " for cycle " + cycleId));
        ReliveCycle existing = cycleStore.findById(cycleId)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + cycleId + " does not exist"));
        String now = Instant.now().toString();
        List<Step> stamped = StepFingerprints.maintain(found.definition().steps(), found.definition().steps());
        ReliveCycle restored = new ReliveCycle(cycleId, found.definition().name(), found.definition().description(),
                stamped,
                found.definition().variables(), found.definition().cycleRules(),
                found.definition().globalRules(), found.definition().settings(), found.definition().noise(),
                found.definition().unexpectedCalls(), existing.createdAt(), now, existing.isTransient(), existing.lastRun(),
                StepFingerprints.indexes(stamped));
        ReliveCycle saved = cycleStore.save(restored);
        notifications.cycleChanged();
        return saved;
    }

    /** data-model.md "Validation on save". */
    private void validate(ReliveCycle cycle) {
        List<String> problems = new ArrayList<>();

        if (cycle.name() == null || cycle.name().isBlank() || cycle.name().length() > 120) {
            problems.add("name must be 1-120 characters");
        }
        if (cycle.description() != null && cycle.description().length() > 2000) {
            problems.add("description must be at most 2000 characters");
        }
        List<Step> steps = cycle.steps() == null ? List.of() : cycle.steps();
        if (steps.size() > ReliveLimits.MAX_STEPS) {
            problems.add("too many steps (max " + ReliveLimits.MAX_STEPS + ")");
        }
        Set<String> stepKeys = new HashSet<>();
        for (Step step : steps) {
            if (!stepKeys.add(step.key())) {
                problems.add("duplicate step key: " + step.key());
            }
        }
        for (Step step : steps) {
            if (step.parentKey() != null) {
                boolean parentIsInbound = steps.stream()
                        .anyMatch(s -> s.key().equals(step.parentKey()) && "inbound".equals(s.direction()));
                if (!parentIsInbound) {
                    problems.add("step " + step.key() + " has parentKey " + step.parentKey() + " which is not an inbound step");
                }
            }
        }

        List<CycleVariable> variables = cycle.variables() == null ? List.of() : cycle.variables();
        if (variables.size() > ReliveLimits.MAX_VARIABLES) {
            problems.add("too many variables (max " + ReliveLimits.MAX_VARIABLES + ")");
        }
        Set<String> variableNames = new HashSet<>();
        for (CycleVariable variable : variables) {
            if (variable.name() == null || !VARIABLE_NAME.matcher(variable.name()).matches()) {
                problems.add("invalid variable name: " + variable.name());
            }
            if (!variableNames.add(variable.name())) {
                problems.add("duplicate variable name: " + variable.name());
            }
        }

        List<CycleRule> cycleRules = cycle.cycleRules() == null ? List.of() : cycle.cycleRules();
        if (cycleRules.size() > ReliveLimits.MAX_CYCLE_RULES) {
            problems.add("too many cycle rules (max " + ReliveLimits.MAX_CYCLE_RULES + ")");
        }
        for (CycleRule rule : cycleRules) {
            problems.addAll(ruleValidation.validate(rule.rule()));
        }
        for (Step step : steps) {
            if (step.callRule() != null && step.callRule().rule() != null) {
                JsonNode actions = step.callRule().rule().path("actions");
                // A LIVE inbound step intentionally has no proxy actions: it passes through to
                // the application. Global interception rules require an action, but this one
                // valid Relive call-rule shape does not.
                boolean inboundPassThrough = "inbound".equals(step.direction())
                        && actions.isArray() && actions.isEmpty();
                if (!inboundPassThrough) {
                    problems.addAll(ruleValidation.validate(step.callRule().rule()));
                }
            }
        }
        if (cycle.unexpectedCalls() != null && cycle.unexpectedCalls().rules() != null) {
            for (CycleRule rule : cycle.unexpectedCalls().rules()) {
                problems.addAll(ruleValidation.validate(rule.rule()));
            }
        }

        if (!problems.isEmpty()) {
            throw new CycleValidationException(problems);
        }
    }
}
