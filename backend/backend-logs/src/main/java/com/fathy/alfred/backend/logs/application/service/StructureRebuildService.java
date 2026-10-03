package com.fathy.alfred.backend.logs.application.service;

import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.ingest.GroupKeyer;
import com.fathy.alfred.backend.logs.domain.ingest.LineBuilder;
import com.fathy.alfred.backend.logs.domain.ingest.PatternMiner;
import com.fathy.alfred.backend.logs.domain.ingest.ValueTyper;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Pattern;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SearchMode;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Applies structure changes to lines already stored, in the background (FR-012, research §R6):
 * re-typing a field converts only that field from its original text (values that do not fit stay as
 * text and are counted); search-mode changes add/drop an index or rebuild the trigram index; role
 * and level changes recompute time, level, group placement, duration and patterns, then the group
 * table. The explorer stays usable throughout; affected fields show "rebuilding".
 */
@Service
public class StructureRebuildService {

    private static final Logger log = LoggerFactory.getLogger(StructureRebuildService.class);
    static final int CHUNK = 50_000;

    private final LogSourceStorePort sources;
    private final LogLineStorePort lines;
    private final LogNotificationPort notifications;
    private final LogIngestService ingest;
    private final Map<String, ExecutorService> perSource = new ConcurrentHashMap<>();

    public StructureRebuildService(LogSourceStorePort sources, LogLineStorePort lines, LogNotificationPort notifications,
                                   LogIngestService ingest) {
        this.sources = sources;
        this.lines = lines;
        this.notifications = notifications;
        this.ingest = ingest;
    }

    @PreDestroy
    void shutdown() {
        perSource.values().forEach(ExecutorService::shutdownNow);
    }

    public void forget(String sourceId) {
        ExecutorService e = perSource.remove(sourceId);
        if (e != null) {
            e.shutdownNow();
        }
    }

    /** What a structure edit needs redone; computed by comparing before and after. */
    public record Plan(List<FieldDef> retype, List<FieldDef> indexOn, List<FieldDef> indexOff, boolean fts, boolean derived) {

        public boolean empty() {
            return retype.isEmpty() && indexOn.isEmpty() && indexOff.isEmpty() && !fts && !derived;
        }

        public String labels() {
            Set<String> l = new LinkedHashSet<>();
            retype.forEach(f -> l.add(f.label()));
            indexOn.forEach(f -> l.add(f.label()));
            indexOff.forEach(f -> l.add(f.label()));
            return String.join(",", l);
        }
    }

    public static Plan plan(LogStructure before, LogStructure after) {
        List<FieldDef> retype = new ArrayList<>();
        List<FieldDef> on = new ArrayList<>();
        List<FieldDef> off = new ArrayList<>();
        boolean fts = false;
        for (FieldDef a : after.fields()) {
            FieldDef b = before.byPath(a.path()).orElse(null);
            if (b == null || !a.stored()) {
                continue;
            }
            if (a.type() != b.type() || !Objects.equals(a.format(), b.format())) {
                retype.add(a);
            }
            if (a.searchMode() != b.searchMode() || (a.searchMode() == SearchMode.EXACT && a.typed() != b.typed())) {
                if (a.searchMode() == SearchMode.EXACT) {
                    on.add(a);
                } else if (b.searchMode() == SearchMode.EXACT) {
                    off.add(a);
                }
                fts |= a.searchMode() == SearchMode.TEXT || b.searchMode() == SearchMode.TEXT;
            }
        }
        boolean derived = !before.groupLevels().equals(after.groupLevels());
        for (Role r : List.of(Role.TIME, Role.LEVEL, Role.DURATION, Role.MESSAGE)) {
            List<String> pb = before.rolesOf(r).stream().map(FieldDef::path).toList();
            List<String> pa = after.rolesOf(r).stream().map(FieldDef::path).toList();
            derived |= !Objects.equals(pb, pa);
        }
        // A re-typed time or duration field changes the derived columns too.
        derived |= retype.stream().anyMatch(f -> f.role() == Role.TIME || f.role() == Role.DURATION);
        return new Plan(retype, on, off, fts, derived);
    }

    public void schedule(String sourceId, Plan plan) {
        if (plan.empty()) {
            return;
        }
        notifications.structureChanged(sourceId, plan.labels().isEmpty() ? "levels" : plan.labels());
        perSource.computeIfAbsent(sourceId, id -> Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "logs-rebuild-" + id);
            t.setDaemon(true);
            return t;
        })).submit(() -> {
            try {
                run(sourceId, plan);
                ingest.changed(sourceId);
            } catch (Exception e) {
                log.error("Rebuilding log source {} failed: {}", sourceId, e.toString());
            } finally {
                notifications.structureChanged(sourceId, "");
            }
        });
    }

    private void run(String sourceId, Plan plan) {
        for (FieldDef f : plan.retype()) {
            retype(sourceId, f);
        }
        for (FieldDef f : plan.indexOff()) {
            lines.setIndex(sourceId, f, false);
        }
        for (FieldDef f : plan.indexOn()) {
            lines.setIndex(sourceId, f, true);
        }
        LogStructure s = sources.structure(sourceId).orElseThrow();
        if (plan.fts()) {
            lines.rebuildFts(sourceId, s.fields().stream().filter(f -> f.stored() && f.searchMode() == SearchMode.TEXT).toList());
        }
        if (plan.derived()) {
            rederive(sourceId, s);
        }
    }

    /** Converts one field from its original text; invalid values are counted on the field (FR-012). */
    void retype(String sourceId, FieldDef f) {
        long[] valid = {0};
        long[] invalid = {0};
        lines.ensureFields(sourceId, List.of(f));
        lines.forEachChunk(sourceId, List.of(f), CHUNK, rows -> {
            List<Long> rids = new ArrayList<>();
            List<Object> values = new ArrayList<>();
            for (var row : rows) {
                String text = row.text().get(f.index());
                if (text == null) {
                    continue;
                }
                Object v = ValueTyper.convert(text, f.type(), f.format()).orElse(null);
                if (v == null) {
                    invalid[0]++;
                } else {
                    valid[0]++;
                }
                rids.add(row.rid());
                values.add(v);
            }
            lines.updateTyped(sourceId, f, rids, values);
        });
        synchronized (ingest.lockFor(sourceId)) {
            LogStructure s = sources.structure(sourceId).orElseThrow();
            long total = valid[0] + invalid[0];
            List<FieldDef> fields = s.fields().stream().map(x -> x.path().equals(f.path())
                    ? x.withMatch(total == 0 ? 1 : valid[0] / (double) total, invalid[0]) : x).toList();
            sources.saveStructure(sourceId, s.withFields(fields));
        }
    }

    /** Recomputes time, level, placement, duration and pattern from stored field text, then groups. */
    void rederive(String sourceId, LogStructure s) {
        List<FieldDef> needed = new ArrayList<>();
        for (Role r : List.of(Role.TIME, Role.LEVEL, Role.DURATION, Role.MESSAGE)) {
            needed.addAll(s.rolesOf(r));
        }
        for (GroupLevel gl : s.groupLevels()) {
            s.byLabel(gl.fieldLabel()).ifPresent(needed::add);
        }
        PatternMiner miner = new PatternMiner(1);
        List<PatternMiner.Cluster> changed = new ArrayList<>();
        Map<Long, String> templates = new HashMap<>();
        long[] lastTs = {0};
        lines.forEachChunk(sourceId, needed.stream().distinct().toList(), CHUNK, rows -> {
            List<LogLineStorePort.Derived> out = new ArrayList<>();
            for (var row : rows) {
                Map<String, Object> values = new HashMap<>();
                for (FieldDef f : needed) {
                    String t = row.text().get(f.index());
                    if (t != null) {
                        values.put(f.path(), t);
                    }
                }
                LineBuilder.Derived d = LineBuilder.derive(s, values, lastTs[0], miner, changed);
                lastTs[0] = d.ts();
                GroupKeyer.Placement p = d.placement();
                out.add(new LogLineStorePort.Derived(row.rid(), d.ts(), d.level(), p.level(), p.path(),
                        LineBuilder.missingLabel(s, p), d.patternId(), d.duration()));
            }
            changed.forEach(c -> templates.put(c.id(), c.template()));
            changed.clear();
            lines.updateDerived(sourceId, out);
        });
        lines.replacePatterns(sourceId, templates.entrySet().stream().map(e -> new Pattern(e.getKey(), e.getValue(), 0, null)).toList());
        lines.rebuildGroups(sourceId);
        ingest.forgetSource(sourceId); // the ingest miner reloads the rebuilt templates
    }
}
