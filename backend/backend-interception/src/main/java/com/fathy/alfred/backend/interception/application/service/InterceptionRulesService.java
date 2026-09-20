package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.ManageInterceptionRulesUseCase;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;
import com.fathy.alfred.backend.interception.domain.model.RuleValidator;
import jakarta.annotation.PostConstruct;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Authoring, validation and persistence of interception rules.
 *
 * <p>Note what this class does NOT do: it never evaluates a rule against a call. Matching and
 * mutation happen entirely inside the mitmproxy addons. Everything here exists to produce a
 * correct snapshot and hand it to {@link RulesPublisherPort}, and every mutating method ends with
 * the same three steps - persist, publish, notify - because a rule that is stored but not
 * published is a rule the user can see and the traffic cannot.
 */
@Service
public class InterceptionRulesService implements ManageInterceptionRulesUseCase {

    private final InterceptionRulesStorePort store;
    private final RulesPublisherPort publisher;
    private final InterceptionNotificationPort notifications;

    public InterceptionRulesService(InterceptionRulesStorePort store,
                                    RulesPublisherPort publisher,
                                    InterceptionNotificationPort notifications) {
        this.store = store;
        this.publisher = publisher;
        this.notifications = notifications;
    }

    /**
     * Republishes on startup so the snapshot the proxy reads always reflects what is actually
     * stored. Without this, a deployment whose rules file was lost (a fresh volume, a cleaned
     * bind mount, a container rebuilt from an image that never had one) would silently run with
     * no interception while the UI listed every rule as active.
     */
    @PostConstruct
    void republishOnStartup() {
        publisher.publish(store.isEnabled(), store.findAll());
    }

    @Override
    public List<InterceptionRule> list() {
        return store.findAll();
    }

    @Override
    public Optional<InterceptionRule> get(String id) {
        return store.findAll().stream().filter(r -> r.id().equals(id)).findFirst();
    }

    @Override
    public InterceptionRule create(InterceptionRule rule) {
        validate(rule);
        String now = Instant.now().toString();
        InterceptionRule saved = rule
                .withId(UUID.randomUUID().toString())
                .withTimestamps(now, now);

        List<InterceptionRule> rules = new ArrayList<>(store.findAll());
        rules.add(saved);
        persist(rules);
        return saved;
    }

    @Override
    public Optional<InterceptionRule> update(String id, InterceptionRule rule) {
        validate(rule);
        List<InterceptionRule> rules = new ArrayList<>(store.findAll());
        for (int i = 0; i < rules.size(); i++) {
            if (!rules.get(i).id().equals(id)) {
                continue;
            }
            // createdAt is the stored one, never the caller's: a client that round-trips a rule
            // through a form would otherwise be able to rewrite when it was made.
            InterceptionRule updated = rule.withId(id)
                    .withTimestamps(rules.get(i).createdAt(), Instant.now().toString());
            rules.set(i, updated);
            persist(rules);
            return Optional.of(updated);
        }
        return Optional.empty();
    }

    @Override
    public boolean delete(String id) {
        List<InterceptionRule> rules = new ArrayList<>(store.findAll());
        if (!rules.removeIf(r -> r.id().equals(id))) {
            return false;
        }
        persist(rules);
        return true;
    }

    @Override
    public Optional<InterceptionRule> setEnabled(String id, boolean enabled) {
        List<InterceptionRule> rules = new ArrayList<>(store.findAll());
        for (int i = 0; i < rules.size(); i++) {
            if (!rules.get(i).id().equals(id)) {
                continue;
            }
            InterceptionRule updated = rules.get(i).withEnabled(enabled)
                    .withTimestamps(rules.get(i).createdAt(), Instant.now().toString());
            rules.set(i, updated);
            persist(rules);
            return Optional.of(updated);
        }
        return Optional.empty();
    }

    @Override
    public List<InterceptionRule> reorder(List<String> idsInOrder) {
        Map<String, InterceptionRule> byId = new LinkedHashMap<>();
        for (InterceptionRule rule : store.findAll()) {
            byId.put(rule.id(), rule);
        }

        List<InterceptionRule> ordered = new ArrayList<>();
        for (String id : idsInOrder) {
            InterceptionRule rule = byId.remove(id);
            if (rule != null) {
                ordered.add(rule);
            }
        }
        // Anything the caller did not mention keeps its relative order, after the rules that were
        // named. A page that was loaded before another tab created a rule would otherwise send an
        // id list missing it, and reordering would delete it.
        ordered.addAll(byId.values());

        List<InterceptionRule> renumbered = new ArrayList<>(ordered.size());
        for (int i = 0; i < ordered.size(); i++) {
            renumbered.add(ordered.get(i).withPriority((i + 1) * 10));
        }
        persist(renumbered);
        return renumbered;
    }

    /**
     * One persist, one publish, one notify for the whole file - which is the entire reason this
     * is a batch and not a loop over {@link #create} on the client.
     *
     * <p>Imported rules are appended AFTER everything already here, renumbered from the highest
     * existing priority upwards while keeping their order from the file. The priorities in the
     * file were relative to the deployment it came from; interleaving them into this one's order
     * would silently change when existing rules run, which is not something an import should be
     * able to do.
     */
    @Override
    public RuleImportResult importRules(List<InterceptionRule> incoming, boolean enable) {
        List<InterceptionRule> rules = new ArrayList<>(store.findAll());
        int nextPriority = rules.stream().mapToInt(InterceptionRule::priority).max().orElse(0) + 10;

        List<RuleImportResult.Outcome> outcomes = new ArrayList<>();
        List<InterceptionRule> created = new ArrayList<>();
        String now = Instant.now().toString();

        for (int index = 0; index < incoming.size(); index++) {
            InterceptionRule candidate = incoming.get(index).withEnabled(enable).withPriority(nextPriority);
            List<String> problems = RuleValidator.validate(candidate);
            if (!problems.isEmpty()) {
                // Rejected on its own, not on behalf of the file - see RuleImportResult.
                outcomes.add(RuleImportResult.Outcome.rejected(index, candidate.name(), problems));
                continue;
            }
            InterceptionRule saved = candidate
                    .withId(UUID.randomUUID().toString())
                    .withTimestamps(now, now);
            created.add(saved);
            outcomes.add(RuleImportResult.Outcome.imported(index, saved.name(), saved.id()));
            nextPriority += 10;
        }

        if (!created.isEmpty()) {
            rules.addAll(created);
            persist(rules);
        }
        return new RuleImportResult(created.size(), outcomes.size() - created.size(), outcomes);
    }

    @Override
    public boolean isMasterSwitchOn() {
        return store.isEnabled();
    }

    @Override
    public void setMasterSwitch(boolean on) {
        store.setEnabled(on);
        publisher.publish(on, store.findAll());
        notifications.rulesChanged();
    }

    private void validate(InterceptionRule rule) {
        List<String> problems = RuleValidator.validate(rule);
        if (!problems.isEmpty()) {
            throw new InvalidRuleException(problems);
        }
    }

    /** Persist, publish, notify - in that order, and never one without the others. */
    private void persist(List<InterceptionRule> rules) {
        rules.sort(Comparator.comparingInt(InterceptionRule::priority));
        store.saveAll(rules);
        publisher.publish(store.isEnabled(), rules);
        notifications.rulesChanged();
    }
}
