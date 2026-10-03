package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.logs.application.port.in.AnnotateLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.out.LogCommentStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogInputStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.application.port.out.RawLineReaderPort;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldStats;
import com.fathy.alfred.backend.logs.domain.model.FieldValues;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.Histogram;
import com.fathy.alfred.backend.logs.domain.model.LineShape;
import com.fathy.alfred.backend.logs.domain.model.LineStructures;
import com.fathy.alfred.backend.logs.domain.model.LogComment;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSource;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.Minimap;
import com.fathy.alfred.backend.logs.domain.model.Pattern;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import com.fathy.alfred.backend.logs.domain.model.Role;
import com.fathy.alfred.backend.logs.domain.model.SavedView;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;


/** Every read of the explorer, plus comments, pins and saved views. */
@Service
public class LogQueryService implements QueryLogsUseCase, AnnotateLogsUseCase {

    /** Sidebar counts and non-indexed stats use this many latest matches (clarification 2026-10-03). */
    static final int WINDOW = 10_000;
    static final int TOP_VALUES = 5;
    static final int MAX_CONTEXT = 100;
    static final int TRACE_LIMIT = 2_000;
    static final int GROUP_PAGE = 500;
    static final int HISTOGRAM_BUCKETS = 120;
    static final int MINIMAP_BUCKETS = 200;
    static final long MINIMAP_SAMPLE_ABOVE = 5_000_000;
    static final int PATTERN_LIMIT = 500;
    static final int INVALID_LIMIT = 100;
    static final int MAX_COMMENT = 4_000;
    static final int MAX_BULK_COMMENT = LogQuery.MAX_SELECTION;
    static final int MAX_VIEWS = 100;
    static final int MAX_VIEW_BYTES = 64 * 1024;
    private static final java.util.regex.Pattern TOKEN = java.util.regex.Pattern.compile("\\{([^}]+)}");

    private final LogSourceStorePort sources;
    private final LogInputStorePort inputs;
    private final LogLineStorePort lines;
    private final LogCommentStorePort comments;
    private final RawLineReaderPort rawReader;
    private final LogNotificationPort notifications;

    private final LogsChangeTracker tracker;

    public LogQueryService(LogSourceStorePort sources, LogInputStorePort inputs, LogLineStorePort lines, LogCommentStorePort comments,
                           RawLineReaderPort rawReader, LogNotificationPort notifications, LogsChangeTracker tracker) {
        this.tracker = tracker;
        this.sources = sources;
        this.inputs = inputs;
        this.lines = lines;
        this.comments = comments;
        this.rawReader = rawReader;
        this.notifications = notifications;
    }

    private LogSource source(String id) {
        return sources.get(id).orElseThrow(() -> LogsException.notFound("Log source"));
    }

    private LogStructure structure(String id) {
        source(id);
        return sources.structure(id).orElseThrow(() -> LogsException.notFound("Structure"));
    }

    private static LogQuery normalize(LogQuery q) {
        try {
            return (q == null ? new LogQuery(List.of(), null, null, null, null, 0) : q).normalized();
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        }
    }

    /**
     * What a list row shows: roles, template tokens (the source's and each structure's own), chosen
     * columns and the level IDs - never every field.
     */
    private List<FieldDef> summaryFields(String sourceId, LogStructure s) {
        List<String> templates = new ArrayList<>();
        templates.add(s.template());
        List<LineShape> shapes = lines.shapes(sourceId);
        shapes.forEach(sh -> templates.add(sh.template()));
        List<FieldDef> out = new ArrayList<>(summaryFields(s, templates));
        // A structure without its own template whose lines have none of the source template's fields
        // would show an empty summary: send a few of its own fields, which the row shows instead.
        Set<Integer> templateFields = new java.util.HashSet<>();
        Matcher m = TOKEN.matcher(s.template() == null ? "" : s.template());
        while (m.find()) {
            s.byLabel(m.group(1)).ifPresent(f -> templateFields.add(f.index()));
        }
        for (LineShape sh : shapes) {
            if ((sh.template() != null && !sh.template().isBlank()) || sh.fields().stream().anyMatch(templateFields::contains)) {
                continue;
            }
            sh.fields().stream().sorted().map(i -> s.fields().stream().filter(f -> f.index() == i).findFirst().orElse(null))
                    .filter(f -> f != null && f.stored() && f.role() == null).limit(FALLBACK_SUMMARY_FIELDS)
                    .filter(f -> !out.contains(f)).forEach(out::add);
        }
        return out;
    }

    /** Fields of a structure shown in place of an empty summary. */
    static final int FALLBACK_SUMMARY_FIELDS = 4;

    static List<FieldDef> summaryFields(LogStructure s, List<String> templates) {
        Set<String> labels = new LinkedHashSet<>();
        s.fields().stream().filter(f -> f.role() != null).forEach(f -> labels.add(f.label()));
        for (String t : templates) {
            Matcher m = TOKEN.matcher(t == null ? "" : t);
            while (m.find()) {
                labels.add(m.group(1));
            }
        }
        labels.addAll(s.columns());
        s.groupLevels().stream().map(GroupLevel::fieldLabel).forEach(labels::add);
        List<FieldDef> out = new ArrayList<>();
        labels.forEach(l -> s.byLabel(l).filter(FieldDef::stored).ifPresent(out::add));
        return out;
    }

    /** Translator errors (unknown field, text compared with >) become 400s with their message. */
    private static <T> T guarded(java.util.function.Supplier<T> call) {
        try {
            return call.get();
        } catch (IllegalArgumentException e) {
            throw LogsException.bad(e.getMessage());
        }
    }

    private List<LogLineSummary> withComments(String sourceId, List<LogLineSummary> rows) {
        if (rows.isEmpty()) {
            return rows;
        }
        Map<String, Integer> counts = comments.counts(sourceId, rows.stream().map(LogLineSummary::lineId).toList());
        if (counts.isEmpty()) {
            return rows;
        }
        return rows.stream().map(r -> counts.containsKey(r.lineId()) ? new LogLineSummary(r.lineId(), r.ts(), r.level(), r.groupLevel(),
                r.groupPath(), r.missingLevel(), r.pinned(), r.unparsed(), r.shape(), r.fields(), counts.get(r.lineId())) : r).toList();
    }

    @Override
    public LogPage lines(String sourceId, LogQuery query) {
        LogStructure s = structure(sourceId);
        LogPage p = guarded(() -> lines.query(sourceId, s, normalize(query), summaryFields(sourceId, s)));
        return new LogPage(withComments(sourceId, p.lines()), p.total(), p.nextCursor(), p.tookMs(), p.slow());
    }

    @Override
    public LogLine line(String sourceId, String lineId) {
        LogSource src = source(sourceId);
        LogStructure s = structure(sourceId);
        LogLine l = lines.get(sourceId, s, lineId).orElseThrow(() -> LogsException.notFound("Line"));
        if (l.raw() != null || src.rawMode() == RawMode.COPY) {
            return l;
        }
        LogInput in = inputs.get(l.inputId()).orElse(null);
        String raw = null;
        String reason = "The input this line came from was removed";
        if (in != null) {
            long position = in.position();
            if (LogIngestService.generationOf(l.byteOffset()) != LogIngestService.generationOf(position)) {
                reason = "The file was rotated since this line was read; its raw text is in the rotated file";
            } else {
                raw = rawReader.read(in.path(), in.fingerprint(), LogIngestService.offsetOf(l.byteOffset())).orElse(null);
                reason = "The original file moved or changed since loading";
            }
        }
        return new LogLine(l.lineId(), l.inputId(), l.byteOffset(), l.ts(), l.level(), l.groupLevel(), l.groupPath(), l.missingLevel(),
                l.pinned(), l.unparsed(), l.shape(), l.fields(), raw, raw == null ? reason : null);
    }

    @Override
    public List<LogLineSummary> context(String sourceId, String lineId, int before, int after) {
        LogStructure s = structure(sourceId);
        int b = Math.max(0, Math.min(MAX_CONTEXT, before));
        int a = Math.max(0, Math.min(MAX_CONTEXT, after));
        return withComments(sourceId, lines.context(sourceId, s, lineId, b, a, summaryFields(sourceId, s)));
    }

    @Override
    public Histogram histogram(String sourceId, LogQuery query, int buckets) {
        LogStructure s = structure(sourceId);
        int n = Math.max(1, Math.min(HISTOGRAM_BUCKETS, buckets));
        LogQuery q = normalize(query);
        return tracker.cached(sourceId, "histogram:" + n, q, () -> guarded(() -> lines.histogram(sourceId, s, q, n)));
    }

    @Override
    public FieldValues fieldValues(String sourceId, LogQuery query) {
        LogStructure s = structure(sourceId);
        LogQuery q = normalize(query);
        return tracker.cached(sourceId, "values", q, () -> guarded(() -> lines.fieldValues(sourceId, s, q,
                s.fields().stream().filter(FieldDef::stored).toList(), WINDOW, TOP_VALUES)));
    }

    @Override
    public FieldStats fieldStats(String sourceId, String label, LogQuery query) {
        LogStructure s = structure(sourceId);
        FieldDef f = s.byLabel(label).filter(FieldDef::stored).orElseThrow(() -> LogsException.notFound("Field"));
        return guarded(() -> lines.fieldStats(sourceId, s, normalize(query), f, WINDOW));
    }

    @Override
    public Minimap minimap(String sourceId, LogQuery query, List<LogQuery.Pill> condition) {
        LogStructure s = structure(sourceId);
        if (condition != null && condition.size() > LogQuery.MAX_PILLS) {
            throw LogsException.bad("Too many minimap conditions");
        }
        LogQuery q = normalize(query);
        return tracker.cached(sourceId, "minimap:" + condition, q,
                () -> guarded(() -> lines.minimap(sourceId, s, q, condition, MINIMAP_BUCKETS, MINIMAP_SAMPLE_ABOVE)));
    }

    @Override
    public List<LogLineSummary> trace(String sourceId, String lineId) {
        LogStructure s = structure(sourceId);
        List<FieldDef> corr = s.rolesOf(Role.CORRELATION);
        if (corr.isEmpty()) {
            throw LogsException.bad("Set a field's role to Correlation to see traces");
        }
        LogLine l = lines.get(sourceId, s, lineId).orElseThrow(() -> LogsException.notFound("Line"));
        // The line's own correlation value: the first correlation field it has (a role may list several).
        Object v = corr.stream().map(f -> l.fields().get(f.label())).filter(java.util.Objects::nonNull).findFirst().orElse(null);
        if (v == null) {
            return List.of();
        }
        return withComments(sourceId, lines.trace(sourceId, s, corr, String.valueOf(v), TRACE_LIMIT, summaryFields(sourceId, s)));
    }

    @Override
    public List<GroupNode> groups(String sourceId, LogQuery query, String parentPath, int offset, int limit) {
        LogStructure s = structure(sourceId);
        if (s.groupLevels().isEmpty()) {
            throw LogsException.bad("Define grouping levels in the structure first");
        }
        String parent = parentPath == null ? "" : parentPath;
        int level = parent.isEmpty() ? 1 : parent.split("\u0001", -1).length + 1;
        int lim = Math.max(1, Math.min(GROUP_PAGE, limit));
        List<GroupNode> nodes = guarded(() -> lines.groups(sourceId, s, normalize(query), parent, level, Math.max(0, offset), lim,
                summaryFields(sourceId, s)));
        return nodes.stream().map(n -> new GroupNode(n.path(), n.level(), n.id(),
                n.headLine() == null ? null : withComments(sourceId, List.of(n.headLine())).get(0),
                withComments(sourceId, n.siblings()), withComments(sourceId, n.skipped()), n.childCount(), n.descendantCount(),
                n.firstTs(), n.lastTs(), n.errorCount(), n.maxDuration())).toList();
    }

    @Override
    public LogPage nodeLines(String sourceId, LogQuery query, String path, boolean skipped) {
        LogStructure s = structure(sourceId);
        if (path == null || path.isEmpty() || path.length() > 4096) {
            throw LogsException.bad("A group path is required");
        }
        int level = path.split("\u0001", -1).length;
        LogPage p = guarded(() -> lines.nodeLines(sourceId, s, normalize(query), path, level, skipped, summaryFields(sourceId, s)));
        return new LogPage(withComments(sourceId, p.lines()), p.total(), p.nextCursor(), p.tookMs(), p.slow());
    }

    @Override
    public List<LogLineSummary> invalidValues(String sourceId, String label) {
        LogStructure s = structure(sourceId);
        FieldDef f = s.byLabel(label).filter(FieldDef::stored).orElseThrow(() -> LogsException.notFound("Field"));
        return lines.invalidValues(sourceId, f, INVALID_LIMIT, summaryFields(sourceId, s));
    }

    @Override
    public LogPage bucket(String sourceId, LogQuery query) {
        LogStructure s = structure(sourceId);
        LogPage p = guarded(() -> lines.bucket(sourceId, s, normalize(query), summaryFields(sourceId, s)));
        return new LogPage(withComments(sourceId, p.lines()), p.total(), p.nextCursor(), p.tookMs(), p.slow());
    }

    @Override
    public List<Pattern> patterns(String sourceId, LogQuery query) {
        LogStructure s = structure(sourceId);
        LogQuery q = normalize(query);
        return tracker.cached(sourceId, "patterns", q, () -> guarded(() -> lines.patterns(sourceId, s, q, PATTERN_LIMIT)));
    }

    @Override
    public LineStructures structures(String sourceId, LogQuery query) {
        LogStructure s = structure(sourceId);
        List<LineShape> shapes = lines.shapes(sourceId);
        Map<Integer, Long> matching = query == null ? Map.of()
                : tracker.cached(sourceId, "shapes", normalize(query), () -> guarded(() -> lines.shapeCounts(sourceId, s, normalize(query))));
        return describe(s, shapes, query == null ? null : matching, lines.hasUnshaped(sourceId));
    }

    /** Names, counts and "seen in X %" for a source's structures; pure, so the editor and tests share it. */
    static LineStructures describe(LogStructure s, List<LineShape> shapes, Map<Integer, Long> matching, boolean pending) {
        Map<Integer, String> labels = new java.util.HashMap<>();
        Set<Integer> roled = new java.util.HashSet<>();
        s.fields().forEach(f -> {
            labels.put(f.index(), f.label());
            if (f.role() != null) {
                roled.add(f.index());
            }
        });
        long total = shapes.stream().mapToLong(LineShape::lineCount).sum();
        Map<Integer, Long> fieldTotals = new java.util.HashMap<>();
        Map<Integer, Integer> shapesWithField = new java.util.HashMap<>();
        for (LineShape sh : shapes) {
            sh.fieldCounts().forEach((i, n) -> fieldTotals.merge(i, n, Long::sum));
            sh.fields().forEach(i -> shapesWithField.merge(i, 1, Integer::sum));
        }
        List<LineStructures.Item> items = new ArrayList<>();
        for (LineShape sh : shapes) {
            if (sh.lineCount() == 0) {
                continue;
            }
            List<String> fields = sh.fieldCounts().keySet().stream().sorted().map(labels::get).filter(java.util.Objects::nonNull).toList();
            boolean named = sh.name() != null && !sh.name().isBlank();
            items.add(new LineStructures.Item(sh.id(), "S" + sh.id(), named ? sh.name() : autoName(sh, shapes.size(), shapesWithField, labels, roled),
                    named, sh.template() == null ? "" : sh.template(), sh.lineCount(),
                    matching == null ? null : matching.getOrDefault(sh.id(), 0L), fields));
        }
        items.sort(java.util.Comparator.comparingLong(LineStructures.Item::lineCount).reversed());
        Map<String, Double> presence = new java.util.LinkedHashMap<>();
        for (FieldDef f : s.fields()) {
            if (f.stored()) {
                presence.put(f.label(), total == 0 ? 0 : fieldTotals.getOrDefault(f.index(), 0L) / (double) total);
            }
        }
        return new LineStructures(items, total, presence, pending);
    }

    /**
     * "with externalService": the field of this structure that the fewest other structures have, preferring
     * one without a role (a time or level field under another name says little about the kind of line).
     */
    private static String autoName(LineShape sh, int shapeCount, Map<Integer, Integer> shapesWithField, Map<Integer, String> labels,
                                   Set<Integer> roled) {
        if (shapeCount <= 1) {
            return "All lines";
        }
        Integer best = null;
        for (Integer i : sh.fields()) {
            if (labels.get(i) == null) {
                continue;
            }
            int a = shapesWithField.getOrDefault(i, 0);
            int b = best == null ? Integer.MAX_VALUE : shapesWithField.getOrDefault(best, 0);
            if (best == null || a < b || (a == b && roled.contains(best) && !roled.contains(i))) {
                best = i;
            }
        }
        if (best == null || shapesWithField.getOrDefault(best, 0) >= shapeCount) {
            return sh.fields().size() + " fields";
        }
        return "with " + labels.get(best);
    }

    // ------------------------------------------------------------------ annotations

    @Override
    public List<LogComment> comments(String sourceId, String lineId) {
        source(sourceId);
        return comments.forLine(sourceId, lineId);
    }

    @Override
    public LogComment comment(String sourceId, String lineId, String path, String text, String authorProfileId) {
        LogStructure s = structure(sourceId);
        String t = text == null ? "" : text.trim();
        if (t.isEmpty() || t.length() > MAX_COMMENT) {
            throw LogsException.bad("A comment is 1-" + MAX_COMMENT + " characters");
        }
        // Any path inside the line may carry a comment - including parts of JSON-in-text that are not
        // structure fields - so it is only length-checked (the DTO caps it), never matched to the structure.
        String p = path == null ? "" : path;
        lines.get(sourceId, s, lineId).orElseThrow(() -> LogsException.notFound("Line"));
        LogComment c = new LogComment(LogSourcesService.id("c", 8), sourceId, lineId, p, t, profile(authorProfileId),
                Instant.now().toString());
        comments.save(c);
        lines.pinOne(sourceId, lineId); // a commented line is kept forever (FR-035)
        notifications.commentChanged(sourceId, lineId);
        return c;
    }

    private static String profile(String id) {
        return id == null || id.isBlank() || id.length() > 64 ? null : id;
    }

    @Override
    public void deleteComment(String sourceId, String commentId) {
        LogComment c = comments.get(commentId).filter(x -> x.sourceId().equals(sourceId))
                .orElseThrow(() -> LogsException.notFound("Comment"));
        comments.delete(commentId);
        notifications.commentChanged(sourceId, c.lineId());
    }

    private List<String> resolve(String sourceId, LogStructure s, Selection sel) {
        if (sel == null) {
            throw LogsException.bad("Nothing selected");
        }
        if (sel.lineIds() != null && !sel.lineIds().isEmpty()) {
            if (sel.lineIds().size() > MAX_BULK_COMMENT) {
                throw LogsException.bad("At most " + MAX_BULK_COMMENT + " lines at once");
            }
            return sel.lineIds();
        }
        LogQuery q = normalize(sel.allMatching());
        long n = guarded(() -> lines.countMatching(sourceId, s, q));
        if (n > MAX_BULK_COMMENT) {
            throw LogsException.bad(n + " lines match - narrow the search to at most " + MAX_BULK_COMMENT);
        }
        return lines.matchingIds(sourceId, s, q, MAX_BULK_COMMENT);
    }

    @Override
    public long commentAll(String sourceId, Selection selection, String text, String authorProfileId) {
        LogStructure s = structure(sourceId);
        String t = text == null ? "" : text.trim();
        if (t.isEmpty() || t.length() > MAX_COMMENT) {
            throw LogsException.bad("A comment is 1-" + MAX_COMMENT + " characters");
        }
        List<String> ids = resolve(sourceId, s, selection);
        String now = Instant.now().toString();
        List<LogComment> out = ids.stream().map(id -> new LogComment(LogSourcesService.id("c", 8), sourceId, id, "", t,
                profile(authorProfileId), now)).toList();
        comments.saveAll(out);
        lines.pin(sourceId, s, new LogQuery(List.of(new LogQuery.Pill(LogQuery.Op.SELECTION, null, null, null, null, ids)),
                null, null, null, null, 0));
        notifications.commentChanged(sourceId, null);
        return out.size();
    }

    @Override
    public long pin(String sourceId, Selection selection) {
        LogStructure s = structure(sourceId);
        if (selection != null && (selection.lineIds() == null || selection.lineIds().isEmpty()) && selection.allMatching() != null) {
            return guarded(() -> lines.pin(sourceId, s, normalize(selection.allMatching())));
        }
        List<String> ids = resolve(sourceId, s, selection);
        return lines.pin(sourceId, s, new LogQuery(List.of(new LogQuery.Pill(LogQuery.Op.SELECTION, null, null, null, null, ids)),
                null, null, null, null, 0));
    }

    @Override
    public List<SavedView> views(String sourceId) {
        source(sourceId);
        return comments.views(sourceId);
    }

    @Override
    public SavedView saveView(String sourceId, String name, JsonNode state) {
        source(sourceId);
        String n = name == null ? "" : name.trim();
        if (n.isEmpty() || n.length() > 80) {
            throw LogsException.bad("A view name is 1-80 characters");
        }
        if (state == null || state.toString().length() > MAX_VIEW_BYTES) {
            throw LogsException.bad("View state is missing or too large");
        }
        if (comments.views(sourceId).size() >= MAX_VIEWS) {
            throw LogsException.bad("At most " + MAX_VIEWS + " saved views per source");
        }
        SavedView v = new SavedView(LogSourcesService.id("v", 6), sourceId, n, state, Instant.now().toString());
        comments.saveView(v);
        return v;
    }

    @Override
    public void deleteView(String sourceId, String viewId) {
        source(sourceId);
        comments.deleteView(sourceId, viewId);
    }
}
