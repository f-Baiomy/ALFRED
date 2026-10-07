package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.GetSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.PreviewSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.in.SaveSettingsUseCase;
import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.DockerSettingsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvConflictException;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.application.port.out.HistoryPort;
import com.fathy.alfred.backend.server.application.port.out.LiveSettingsPort;
import com.fathy.alfred.backend.server.application.port.out.PendingRestartPort;
import com.fathy.alfred.backend.server.application.port.out.ServerEventsPort;
import com.fathy.alfred.backend.server.application.port.out.SupervisorPort;
import com.fathy.alfred.backend.server.domain.model.ApplyMode;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.EnvProblem;
import com.fathy.alfred.backend.server.domain.model.HistoryEntry;
import com.fathy.alfred.backend.server.domain.model.PendingRestart;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.SettingCatalog;
import com.fathy.alfred.backend.server.domain.model.SettingDefinition;
import com.fathy.alfred.backend.server.domain.model.SettingValue;
import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.fathy.alfred.backend.server.domain.model.SettingsValidator;
import com.fathy.alfred.backend.server.domain.model.Source;
import com.fathy.alfred.backend.server.domain.model.ValidationResult;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.BiFunction;

/**
 * Reading, previewing and saving the deploy-time settings in .env. Spring-free (ArchUnit-enforced): the backend wires
 * it in ServerSliceConfiguration and ServerConfigCli wires the same class without Spring, so the UI and "alfred config"
 * validate and write with one implementation (research R7).
 *
 * <p>A save is all-or-nothing on the file: every value is validated first (FR-031), the write is atomic and refused
 * when .env changed after it was loaded (FR-036). Applying comes after the write and is best effort per setting - a
 * LIVE setting that fails to apply is reported, and is in effect after the next restart anyway, because .env is what
 * every start reads.
 */
public class ServerSettingsService implements GetSettingsUseCase, PreviewSettingsUseCase, SaveSettingsUseCase {

    static final String MASKED = "<set>";

    private final EnvFilePort envFile;
    private final DefaultsPort defaults;
    private final HistoryPort history;
    private final PendingRestartPort pending;
    private final LiveSettingsPort live;
    private final SupervisorPort supervisor;
    private final DockerSettingsPort docker;
    private final ServerEventsPort events;
    private final RuntimeMode mode;
    private final Clock clock;
    private final BiFunction<Map<String, String>, Set<String>, List<ValidationResult>> probes;
    private final Object saveLock = new Object();

    public ServerSettingsService(EnvFilePort envFile, DefaultsPort defaults, HistoryPort history, PendingRestartPort pending,
                                 LiveSettingsPort live, SupervisorPort supervisor, DockerSettingsPort docker,
                                 ServerEventsPort events, RuntimeMode mode, Clock clock,
                                 BiFunction<Map<String, String>, Set<String>, List<ValidationResult>> probes) {
        this.envFile = envFile;
        this.defaults = defaults;
        this.history = history;
        this.pending = pending;
        this.live = live;
        this.supervisor = supervisor;
        this.docker = docker;
        this.events = events;
        this.mode = mode;
        this.clock = clock;
        this.probes = probes;
    }

    /** One lock for saves and restarts: a restart asked for during a save waits for the save to finish. */
    public Object saveLock() {
        return saveLock;
    }

    // ------------------------------------------------------------------------------------------------------------------
    // read
    // ------------------------------------------------------------------------------------------------------------------

    @Override
    public SettingsView settings() {
        EnvDocument document = mode == RuntimeMode.NATIVE ? envFile.read() : EnvDocument.empty();
        Map<String, String> env = document.entries();
        Map<String, String> defaultValues = defaults.defaults();
        Map<String, PendingRestart> pendingByKey = new HashMap<>();
        pending.all().forEach(p -> pendingByKey.put(p.key(), p));

        List<SettingValue> values = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        for (SettingDefinition definition : SettingCatalog.all()) {
            String key = definition.key();
            String defaultValue = defaultValues.getOrDefault(key, "");
            String value;
            Source source;
            if (mode == RuntimeMode.DOCKER) {
                value = docker.effectiveValue(key).orElse(null);
                source = Source.PROCESS_ENV;
            } else if (env.containsKey(key)) {
                value = env.get(key);
                source = Source.ENV_FILE;
            } else {
                value = defaultValue;
                source = Source.DEFAULT;
                missing.add(key);
            }
            boolean differs = value != null && !value.equals(defaultValue);
            boolean isSet = value != null && !value.isBlank();
            values.add(new SettingValue(definition, definition.secret() ? null : value, isSet, source,
                    definition.secret() ? null : defaultValue, differs, pendingByKey.get(key)));
        }
        List<EnvProblem> problems = mode == RuntimeMode.NATIVE ? EnvProblem.of(document) : List.of();
        return new SettingsView(mode, envFile.location(), document.contentHash(), values, missing, problems, pending.all());
    }

    /** The effective value of every setting: .env over the defaults. */
    public Map<String, String> effective() {
        Map<String, String> out = new LinkedHashMap<>(defaults.defaults());
        out.putAll(envFile.read().entries());
        return out;
    }

    // ------------------------------------------------------------------------------------------------------------------
    // preview
    // ------------------------------------------------------------------------------------------------------------------

    @Override
    public Preview preview(SettingsChange change) {
        EnvDocument document = envFile.read();
        Planned planned = plan(document, change);
        List<DiffLine> diff = new ArrayList<>();
        List<Effect> effects = new ArrayList<>();
        Map<String, String> before = document.entries();
        for (String key : planned.edited) {
            SettingDefinition definition = SettingCatalog.find(key).orElse(null);
            if (definition == null) {
                continue;
            }
            String after = planned.document.entries().get(key);
            String old = before.get(key);
            if (Objects.equals(old, after) && before.containsKey(key) == planned.document.entries().containsKey(key)) {
                continue;
            }
            diff.add(new DiffLine(key, line(definition, old), line(definition, after)));
            effects.add(new Effect(key, definition.applies()));
        }
        return new Preview(diff, effects, planned.results);
    }

    private static String line(SettingDefinition definition, String value) {
        if (value == null) {
            return null;
        }
        return definition.key() + "=" + (definition.secret() && !value.isEmpty() ? MASKED : value);
    }

    // ------------------------------------------------------------------------------------------------------------------
    // save
    // ------------------------------------------------------------------------------------------------------------------

    @Override
    public Saved save(SettingsChange change, HistoryEntry.HistorySource source, String sourceDetail) {
        requireNative();
        synchronized (saveLock) {
            EnvDocument document = envFile.read();
            if (change.baseHash() != null && !change.baseHash().equals(document.contentHash())) {
                List<String> changedKeys = changedSinceLastKnown(document);
                recordHandEdit(document);
                throw new SettingsConflictException(changedKeys, document.contentHash());
            }
            recordHandEdit(document);
            Planned planned = plan(document, change);
            List<ValidationResult> errors = planned.results.stream()
                    .filter(r -> r.level() == ValidationResult.Level.ERROR).toList();
            if (!errors.isEmpty()) {
                throw new SettingsRefusedException(planned.results);
            }
            return write(document, planned, source, sourceDetail);
        }
    }

    @Override
    public Saved addMissing(HistoryEntry.HistorySource source, String sourceDetail) {
        requireNative();
        synchronized (saveLock) {
            EnvDocument document = envFile.read();
            Map<String, String> env = document.entries();
            Map<String, String> defaultValues = defaults.defaults();
            List<SettingsChange.Edit> edits = new ArrayList<>();
            for (SettingDefinition definition : SettingCatalog.all()) {
                if (!env.containsKey(definition.key())) {
                    edits.add(SettingsChange.Edit.set(definition.key(), defaultValues.getOrDefault(definition.key(), "")));
                }
            }
            Planned planned = plan(document, new SettingsChange(document.contentHash(), edits));
            return write(document, planned, source, sourceDetail);
        }
    }

    private Saved write(EnvDocument document, Planned planned, HistoryEntry.HistorySource source, String sourceDetail) {
        Map<String, String> before = document.entries();
        Map<String, String> after = planned.document.entries();
        List<HistoryEntry.Change> changes = new ArrayList<>();
        Set<String> changedKeys = new LinkedHashSet<>();
        for (String key : planned.edited) {
            boolean presenceChanged = before.containsKey(key) != after.containsKey(key);
            if (presenceChanged || !Objects.equals(before.get(key), after.get(key))) {
                changedKeys.add(key);
                changes.add(historyChange(key, before.get(key), after.get(key)));
            }
        }
        if (changedKeys.isEmpty()) {
            return new Saved(document.contentHash(), List.of(), 0);
        }
        try {
            envFile.write(planned.document, document.contentHash());
        } catch (EnvConflictException e) {
            throw new SettingsConflictException(changedSinceLastKnown(envFile.read()), e.currentHash());
        }
        String written = planned.document.render();
        long historyId = history.append(source, sourceDetail, changes, document.render(), written);
        Map<String, String> defaultValues = defaults.defaults();
        List<Applied> applied = apply(changedKeys, before, after, defaultValues);
        events.serverChanged("settings");
        return new Saved(EnvDocument.hashOf(written), applied, historyId);
    }

    private List<Applied> apply(Set<String> changedKeys, Map<String, String> before, Map<String, String> after,
                                Map<String, String> defaultValues) {
        List<Applied> applied = new ArrayList<>();
        List<PendingRestart> waiting = new ArrayList<>(pending.all());
        Map<String, String> effectiveAfter = new LinkedHashMap<>(defaultValues);
        effectiveAfter.putAll(after);
        boolean proxies = false;
        for (String key : changedKeys) {
            SettingDefinition definition = SettingCatalog.find(key).orElseThrow();
            String oldValue = before.getOrDefault(key, defaultValues.getOrDefault(key, ""));
            String newValue = after.getOrDefault(key, defaultValues.getOrDefault(key, ""));
            switch (definition.applies()) {
                case LIVE -> {
                    long started = System.nanoTime();
                    try {
                        live.apply(key, effectiveAfter);
                        applied.add(new Applied(key, ApplyMode.LIVE, Outcome.APPLIED, millisSince(started), ""));
                    } catch (RuntimeException e) {
                        applied.add(new Applied(key, ApplyMode.LIVE, Outcome.SAVED, millisSince(started),
                                "saved; it takes effect after a restart (" + e.getMessage() + ")"));
                    }
                }
                case PROXIES -> {
                    proxies = true;
                    try {
                        live.apply(key, effectiveAfter); // the backend's own view (e.g. the inbound project list)
                    } catch (RuntimeException ignored) {
                        // nothing in the backend reads it while running; the proxies are restarted below
                    }
                }
                case RESTART -> {
                    // What the running process uses: the "before" of a change already waiting, else the old value.
                    String inEffect = waiting.stream().filter(p -> p.key().equals(key)).findFirst()
                            .map(PendingRestart::before).orElse(definition.secret() ? MASKED : oldValue);
                    waiting.removeIf(p -> p.key().equals(key));
                    if (definition.secret() || !Objects.equals(inEffect, newValue)) {
                        waiting.add(new PendingRestart(key, inEffect, definition.secret() ? MASKED : newValue, clock.instant()));
                    }
                    applied.add(new Applied(key, ApplyMode.RESTART, Outcome.PENDING_RESTART, 0, ""));
                }
            }
        }
        pending.replace(waiting);
        // Any change may alter what the supervisor runs (proxy arguments, the Windows log agent's folders): it compares
        // and restarts only the children whose command or environment changed.
        long started = System.nanoTime();
        List<String> restarted = supervisor.available() ? supervisor.reload() : List.of();
        long took = millisSince(started);
        if (proxies) {
            for (String key : changedKeys) {
                SettingDefinition definition = SettingCatalog.find(key).orElseThrow();
                if (definition.applies() == ApplyMode.PROXIES) {
                    applied.add(supervisor.available()
                            ? new Applied(key, ApplyMode.PROXIES, Outcome.PROXIES_RESTARTED, took, String.join(", ", restarted))
                            : new Applied(key, ApplyMode.PROXIES, Outcome.SAVED, took, "saved; the proxies use it after a restart"));
                }
            }
        }
        return applied;
    }

    private static long millisSince(long nanos) {
        return (System.nanoTime() - nanos) / 1_000_000;
    }

    private static HistoryEntry.Change historyChange(String key, String before, String after) {
        boolean secret = SettingCatalog.find(key).map(SettingDefinition::secret).orElse(false);
        if (secret) {
            return new HistoryEntry.Change(key, before == null ? null : "set", after == null ? null : "changed");
        }
        return new HistoryEntry.Change(key, before, after);
    }

    // ------------------------------------------------------------------------------------------------------------------
    // planning: normalise, validate, apply the edits to a copy of the document
    // ------------------------------------------------------------------------------------------------------------------

    private record Planned(EnvDocument document, Set<String> edited, List<ValidationResult> results) {
    }

    private Planned plan(EnvDocument document, SettingsChange change) {
        EnvDocument next = document;
        Set<String> edited = new LinkedHashSet<>();
        List<ValidationResult> results = new ArrayList<>();
        Map<String, String> effective = new LinkedHashMap<>(defaults.defaults());
        effective.putAll(document.entries());
        for (SettingsChange.Edit edit : change.edits()) {
            SettingDefinition definition = SettingCatalog.find(edit.key()).orElse(null);
            if (definition == null) {
                results.add(ValidationResult.error(edit.key(), "not a setting"));
                continue;
            }
            edited.add(edit.key());
            if (edit.reset()) {
                next = next.remove(edit.key());
                effective.put(edit.key(), defaults.defaults().getOrDefault(edit.key(), ""));
                continue;
            }
            String raw = edit.value() == null ? "" : edit.value();
            String value;
            try {
                value = SettingsValidator.normalize(definition, raw);
            } catch (SettingsValidator.InvalidValue e) {
                results.add(ValidationResult.error(edit.key(), e.getMessage()));
                value = raw.strip();
            }
            next = next.set(edit.key(), value, definition.group().envHeader());
            effective.put(edit.key(), value);
        }
        Set<String> formatChecked = new LinkedHashSet<>(edited);
        results.stream().map(ValidationResult::key).forEach(formatChecked::remove);
        results.addAll(SettingsValidator.validate(effective, formatChecked));
        results.addAll(probes.apply(effective, formatChecked));
        return new Planned(next, edited, results);
    }

    // ------------------------------------------------------------------------------------------------------------------
    // hand edits (FR-034, FR-036)
    // ------------------------------------------------------------------------------------------------------------------

    /** Records a change made to .env outside Alfred (an editor, a script) as a HAND_EDIT history entry, once. */
    public void recordHandEdit(EnvDocument current) {
        Optional<String> lastKnown = history.lastKnownContent();
        if (lastKnown.isEmpty() || EnvDocument.hashOf(lastKnown.get()).equals(current.contentHash())) {
            return;
        }
        Map<String, String> before = EnvDocument.parse(lastKnown.get()).entries();
        Map<String, String> after = current.entries();
        List<HistoryEntry.Change> changes = new ArrayList<>();
        Set<String> keys = new LinkedHashSet<>(before.keySet());
        keys.addAll(after.keySet());
        for (String key : keys) {
            if (!Objects.equals(before.get(key), after.get(key))) {
                changes.add(historyChange(key, before.get(key), after.get(key)));
            }
        }
        history.append(HistoryEntry.HistorySource.HAND_EDIT, "file changed outside Alfred", changes, lastKnown.get(),
                current.render());
    }

    private List<String> changedSinceLastKnown(EnvDocument current) {
        Optional<String> lastKnown = history.lastKnownContent();
        if (lastKnown.isEmpty()) {
            return List.of();
        }
        Map<String, String> before = EnvDocument.parse(lastKnown.get()).entries();
        Map<String, String> after = current.entries();
        Set<String> keys = new LinkedHashSet<>(before.keySet());
        keys.addAll(after.keySet());
        return keys.stream().filter(k -> !Objects.equals(before.get(k), after.get(k))).toList();
    }

    private void requireNative() {
        if (mode != RuntimeMode.NATIVE) {
            throw new IllegalStateException("Alfred runs with Docker here: settings are changed in .env and applied with restart.py");
        }
    }
}
