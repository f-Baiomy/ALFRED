package com.fathy.alfred.backend.logs.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.logs.adapter.out.input.FileLineSource;
import com.fathy.alfred.backend.logs.adapter.out.input.LocalLogFiles;
import com.fathy.alfred.backend.logs.adapter.out.rawfile.OffsetRawLineReader;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogCommentStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogInputStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogLineStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogSourceStoreAdapter;
import com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogsRepository;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.FieldType;
import com.fathy.alfred.backend.logs.domain.model.GroupLevel;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.GroupSort;
import com.fathy.alfred.backend.logs.domain.model.IngestProgress;
import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.InputStatus;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import com.fathy.alfred.backend.logs.domain.model.PrivacyMode;
import com.fathy.alfred.backend.logs.domain.model.RawMode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The whole slice below the controllers, on a real logs.db: a server file is previewed, loaded,
 * then searched, grouped, inspected, commented, re-typed and trimmed by retention.
 */
class LogsIngestAndQueryIntegrationTest {

    @TempDir
    Path dir;

    private SqliteLogsRepository repository;
    private SqliteLogLineStoreAdapter lineStore;
    private SqliteLogInputStoreAdapter inputStore;
    private SqliteLogSourceStoreAdapter sourceStore;
    private LogNotificationPort quiet;
    private LogIngestService ingest;
    private LogSourcesService sources;
    private LogQueryService query;
    private final List<String> lines = new ArrayList<>();

    private static String line(String ts, String level, String msg, String sid, String ic, String ex, Integer took, String code) {
        StringBuilder b = new StringBuilder("{\"timestamp\":\"" + ts + "\",\"log.level\":\"" + level + "\",\"message\":{\"message\":\"" + msg + "\"");
        if (sid != null) b.append(",\"sessionId\":\"").append(sid).append('"');
        if (ic != null) b.append(",\"inboundCallId\":\"").append(ic).append('"');
        if (ex != null) b.append(",\"externalCallId\":\"").append(ex).append('"');
        b.append(",\"context\":{\"request\":\"LoginDTO(email=evilanotravel@gmail.com, user=AGN1422)\"");
        if (took != null) b.append(",\"timeTaken\":").append(took).append(",\"tookText\":\"").append(took).append("ms\"");
        if (code != null) b.append(",\"code\":\"").append(code).append('"');
        return b.append("}}}").toString();
    }

    private final LogsChangeTracker tracker = new LogsChangeTracker();

    @BeforeEach
    void setUp() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        repository = new SqliteLogsRepository();
        ReflectionTestUtils.setField(repository, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.invokeMethod(repository, "init");
        lineStore = new SqliteLogLineStoreAdapter(repository);
        sourceStore = new SqliteLogSourceStoreAdapter(repository, mapper);
        inputStore = new SqliteLogInputStoreAdapter(repository);
        var commentStore = new SqliteLogCommentStoreAdapter(repository, mapper);
        quiet = new LogNotificationPort() {
            public void linesAdded(String s, long c, long t) { }
            public void progress(IngestProgress p) { }
            public void structureChanged(String s, String r) { }
            public void sourcesChanged() { }
            public void commentChanged(String s, String l) { }
        };
        ingest = new LogIngestService(sourceStore, inputStore, lineStore, new FileLineSource(), quiet, mapper, tracker, new FileChangeSignals());
        ReflectionTestUtils.setField(ingest, "dbFile", dir.resolve("logs.db").toString());
        ReflectionTestUtils.setField(ingest, "minFreeBytes", 0L);
        ReflectionTestUtils.setField(ingest, "followStatMs", 20L);
        StructureRebuildService rebuild = new StructureRebuildService(sourceStore, lineStore, quiet, ingest);
        LocalLogFiles files = new LocalLogFiles();
        ReflectionTestUtils.setField(files, "rootDir", dir.resolve("drop").toString());
        ReflectionTestUtils.setField(files, "uploadDir", dir.resolve("uploads").toString());
        var watchFolders = new com.fathy.alfred.backend.logs.adapter.out.input.LocalWatchFolders();
        var watch = new LogWatchService(watchFolders, inputStore, ingest, new FileChangeSignals(), quiet, mapper);
        sources = new LogSourcesService(sourceStore, inputStore, lineStore, commentStore, files, quiet, ingest, rebuild, mapper, watch,
                new com.fathy.alfred.backend.logs.adapter.out.sqlite.SqliteLogSessionStoreAdapter(repository, mapper));
        query = new LogQueryService(sourceStore, inputStore, lineStore, commentStore, new OffsetRawLineReader(), quiet, tracker);

        lines.add(line("2026-10-01T20:00:00Z", "INFO", "session start", "S1", null, null, null, "200"));
        lines.add(line("2026-10-01T20:00:01Z", "INFO", "inbound request", "S1", "IC7", null, null, "200"));
        lines.add(line("2026-10-01T20:00:02Z", "INFO", "Start external call", "S1", "IC7", "EX31", null, "200"));
        lines.add(line("2026-10-01T20:00:32Z", "ERROR", "Supplier timeout", "S1", "IC7", "EX31", 30000, "504"));
        lines.add(line("2026-10-01T20:00:33Z", "INFO", "inbound response", "S1", "IC7", null, 32000, "200"));
        lines.add(line("2026-10-01T20:00:34Z", "INFO", "cache lookup", "S1", null, "EX99", null, "200"));
        lines.add(line("2026-10-01T20:01:00Z", "WARN", "orphan request", "S0999", "IC8", null, 1500, "429"));
        lines.add(line("2026-10-01T20:02:00Z", "INFO", "scheduler tick", null, null, null, null, "200"));
        Path drop = Files.createDirectories(dir.resolve("drop"));
        Files.writeString(drop.resolve("detail.log"), String.join("\n", lines) + "\n{not json at all\n", StandardCharsets.UTF_8);
    }

    @AfterEach
    void tearDown() {
        ReflectionTestUtils.invokeMethod(ingest, "shutdown");
        ReflectionTestUtils.invokeMethod(repository, "close");
    }

    private static void await(Supplier<Boolean> condition) throws InterruptedException {
        for (int i = 0; i < 200 && !condition.get(); i++) {
            Thread.sleep(50);
        }
        assertThat(condition.get()).isTrue();
    }

    private String loadSource() throws Exception {
        ManageLogSourcesUseCase.Preview preview = sources.preview(null, "detail.log");
        LogStructure s = preview.structure();
        LogStructure withLevels = new LogStructure(s.id(), s.fields(), List.of(new GroupLevel("sessionId", GroupSort.TIME_ASC),
                new GroupLevel("inboundCallId", GroupSort.TIME_ASC), new GroupLevel("externalCallId", GroupSort.TIME_ASC)),
                s.template(), List.of(), s.defaultDataView(), "UTC");
        String id = sources.create("detail", RawMode.COPY, PrivacyMode.SHOW, withLevels).source().id();
        LogInput in = sources.add(id, InputKind.SERVER_FILE, "detail.log", null, true, false);
        await(() -> inputStore.get(in.id()).map(i -> i.status() == InputStatus.DONE).orElse(false));
        return id;
    }

    private static LogQuery q(LogQuery.Pill... pills) {
        return new LogQuery(List.of(pills), null, null, null, null, 0);
    }

    private static LogQuery.Pill pill(LogQuery.Op op, String field, String value) {
        return new LogQuery.Pill(op, field, value, null, null, null);
    }

    private java.util.Set<String> ids(String id, LogQuery.Pill... pills) {
        return query.lines(id, new LogQuery(List.of(pills), null, null, null, null, 500)).lines().stream().map(l -> l.lineId())
                .collect(java.util.stream.Collectors.toSet());
    }

    private static LogQuery.Pill full(LogQuery.Op op, String field, String value, List<String> values, Boolean not, Boolean or) {
        return new LogQuery.Pill(op, field, value, null, null, null, values, not, or);
    }

    @Test
    void filtersCombineWithOrAnyOfContainsAndFilterOutAndSayWhatEachHides() throws Exception {
        String id = loadSource();
        var all = ids(id);
        var error = ids(id, pill(LogQuery.Op.EQ, "level", "ERROR"));
        var slow = ids(id, pill(LogQuery.Op.GT, "timeTaken", "5000"));
        var withCall = ids(id, pill(LogQuery.Op.EXISTS, "externalCallId", null));

        // OR between two filters = the union; a third, ANDed filter narrows the union.
        var either = ids(id, pill(LogQuery.Op.EQ, "level", "ERROR"), full(LogQuery.Op.GT, "timeTaken", "5000", null, null, true));
        var union = new java.util.HashSet<>(error);
        union.addAll(slow);
        assertThat(either).isEqualTo(union);
        var narrowed = ids(id, pill(LogQuery.Op.EQ, "level", "ERROR"), full(LogQuery.Op.GT, "timeTaken", "5000", null, null, true),
                pill(LogQuery.Op.EXISTS, "externalCallId", null));
        var expected = new java.util.HashSet<>(union);
        expected.retainAll(withCall);
        assertThat(narrowed).isEqualTo(expected);

        // "is any of" = several EQ ORed; "is none of" keeps lines without the field.
        var codes = List.of("504", "429");
        var anyOf = ids(id, full(LogQuery.Op.EQ, "code", null, codes, null, null));
        var byOr = ids(id, pill(LogQuery.Op.EQ, "code", codes.get(0)), full(LogQuery.Op.EQ, "code", codes.get(1), null, null, true));
        assertThat(anyOf).isEqualTo(byOr).isNotEmpty();
        var noneOf = ids(id, full(LogQuery.Op.NEQ, "code", null, codes, null, null));
        var rest = new java.util.HashSet<>(all);
        rest.removeAll(anyOf);
        assertThat(noneOf).isEqualTo(rest);

        // "contains" on one field, case-insensitive; "filter out" of any filter = everything else (missing field included).
        var contains = ids(id, pill(LogQuery.Op.CONTAINS, "level", "err"));
        assertThat(contains).isEqualTo(error);
        var notSlow = ids(id, full(LogQuery.Op.GT, "timeTaken", "5000", null, true, null));
        var notSlowExpected = new java.util.HashSet<>(all);
        notSlowExpected.removeAll(slow);
        assertThat(notSlow).isEqualTo(notSlowExpected);

        // How many lines each filter hides: matches without it minus matches with it.
        var impact = query.pillImpact(id, q(pill(LogQuery.Op.EXISTS, "externalCallId", null), pill(LogQuery.Op.GT, "timeTaken", "5000")));
        var both = new java.util.HashSet<>(withCall);
        both.retainAll(slow);
        assertThat(impact).containsExactly((long) slow.size() - both.size(), (long) withCall.size() - both.size());

        // An explicit span: the histogram covers exactly it, empty edges included.
        long t0 = query.lines(id, q()).lines().stream().mapToLong(l -> l.ts()).min().orElseThrow();
        var h = query.histogram(id, new LogQuery(List.of(), t0 - 3_600_000L, t0 + 3_600_000L, null, null, 0), 4);
        assertThat(h.from()).isEqualTo(t0 - 3_600_000L);
        assertThat(h.buckets()).hasSize(4);
    }

    @Test
    void loadsSearchesAndShowsEveryLineExactlyAsReceived() throws Exception {
        String id = loadSource();
        var all = query.lines(id, q());
        assertThat(all.total()).isEqualTo(9); // 8 JSON lines + 1 kept as unparsed
        assertThat(all.lines().stream().filter(l -> l.unparsed()).count()).isEqualTo(1);

        assertThat(query.lines(id, q(pill(LogQuery.Op.TEXT, null, "anotrav"))).total()).isEqualTo(8);
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).total()).isEqualTo(1);
        assertThat(query.lines(id, q(pill(LogQuery.Op.GT, "timeTaken", "5000"))).total()).isEqualTo(2);
        assertThat(query.lines(id, q(pill(LogQuery.Op.EXISTS, "externalCallId", null))).total()).isEqualTo(3);
        assertThat(query.lines(id, q(pill(LogQuery.Op.NEQ, "code", "200"))).total()).isEqualTo(3); // 504, 429 and the unparsed line
        assertThatThrownBy(() -> query.lines(id, q(pill(LogQuery.Op.GT, "message", "300"))))
                .isInstanceOf(LogsException.class).hasMessageContaining("text");

        String errorId = query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).lines().get(0).lineId();
        LogLine full = query.line(id, errorId);
        assertThat(full.raw()).isEqualTo(lines.get(3));
        assertThat(full.fields()).containsEntry("timeTaken", 30000L).doesNotContainKey("email");
        // The request (request-body role) is one field: its text, not a field per DTO property.
        assertThat(String.valueOf(full.fields().get("request"))).contains("email=evilanotravel@gmail.com");
        assertThat(query.context(id, errorId, 1, 1)).hasSize(3);

        // Keyset paging: two pages of 4 then the rest, no repeats.
        var p1 = query.lines(id, new LogQuery(List.of(), null, null, null, null, 4));
        var p2 = query.lines(id, new LogQuery(List.of(), null, null, null, p1.nextCursor(), 4));
        assertThat(p2.lines()).extracting(l -> l.lineId()).doesNotContainAnyElementsOf(p1.lines().stream().map(l -> l.lineId()).toList());
    }

    @Test
    void groupsByLevelsWithPlaceholderSiblingsSkippedAndBucket() throws Exception {
        String id = loadSource();
        List<GroupNode> roots = query.groups(id, q(), "", 0, 50);
        assertThat(roots).extracting(GroupNode::id).containsExactly("S1", "S0999");
        GroupNode s1 = roots.get(0);
        assertThat(s1.headLine().fields()).containsEntry("message", "session start");
        assertThat(s1.skipped()).hasSize(1);
        assertThat(s1.skipped().get(0).missingLevel()).isEqualTo("inboundCallId");
        assertThat(s1.childCount()).isEqualTo(1);
        assertThat(roots.get(1).headLine()).isNull(); // S0999 has no level-1 line: placeholder

        GroupNode ic7 = query.groups(id, q(), "S1", 0, 50).get(0);
        assertThat(ic7.headLine().fields()).containsEntry("message", "inbound request");
        assertThat(ic7.siblings()).extracting(l -> l.fields().get("message")).containsExactly("inbound response");
        GroupNode ex31 = query.groups(id, q(), "S1\u0001IC7", 0, 50).get(0);
        assertThat(ex31.headLine().fields()).containsEntry("message", "Start external call");
        assertThat(ex31.errorCount()).isEqualTo(1);

        assertThat(query.bucket(id, q()).total()).isEqualTo(2); // scheduler tick + unparsed

        // Filtered: only the error's chain remains.
        List<GroupNode> filtered = query.groups(id, q(pill(LogQuery.Op.EQ, "level", "ERROR")), "", 0, 50);
        assertThat(filtered).extracting(GroupNode::id).containsExactly("S1");
    }

    @Test
    void commentsPinAndRetentionKeepsPinnedLines() throws Exception {
        String id = loadSource();
        String errorId = query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).lines().get(0).lineId();
        query.comment(id, errorId, "message.context.timeTaken", "times out at exactly 30 s", "p1");
        assertThat(query.comments(id, errorId)).singleElement().satisfies(c -> assertThat(c.path()).isEqualTo("message.context.timeTaken"));
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).lines().get(0).commentCount()).isEqualTo(1);

        lineStore.applyRetention(id, Long.MAX_VALUE, 0);
        long[] counts = lineStore.counts(id); // as LogIngestService.applyRetention does after removing lines
        sourceStore.setCounts(id, counts[0], counts[1]);
        assertThat(query.lines(id, q()).total()).isEqualTo(1);
        assertThat(query.lines(id, q()).lines().get(0).lineId()).isEqualTo(errorId);
    }

    @Test
    void retypingAFieldConvertsStoredValuesInTheBackground() throws Exception {
        String id = loadSource();
        LogStructure s = sources.structure(id);
        assertThat(s.byLabel("tookText").orElseThrow().type()).isEqualTo(FieldType.STRING);
        List<FieldDef> fields = s.fields().stream().map(f -> f.label().equals("tookText")
                ? f.withType(FieldType.NUMBER, "unit: ms", f.typeSource()) : f).toList();
        sources.updateStructure(id, s.withFields(fields));
        await(() -> {
            try {
                return query.lines(id, q(pill(LogQuery.Op.GT, "tookText", "5000"))).total() == 2
                        && sources.structure(id).byLabel("tookText").orElseThrow().invalidCount() == 0
                        && sources.structure(id).byLabel("tookText").orElseThrow().matchRate() == 1.0;
            } catch (LogsException e) {
                return false;
            }
        });
        assertThat(sources.structure(id).byLabel("tookText").orElseThrow().typeSource().name()).isEqualTo("USER");
    }

    @Test
    void histogramValuesStatsPatternsAndMinimapAreBounded() throws Exception {
        String id = loadSource();
        var h = query.histogram(id, q(), 10);
        assertThat(h.buckets()).hasSize(10);
        assertThat(h.buckets().stream().mapToLong(b -> b.byLevel().getOrDefault("ERROR", 0L)).sum()).isEqualTo(1);

        var values = query.fieldValues(id, q());
        assertThat(values.window()).isEqualTo(LogQueryService.WINDOW);
        assertThat(values.fields().get("level").top()).extracting(v -> v.value()).contains("INFO", "ERROR", "WARN");

        var stats = query.fieldStats(id, "timeTaken", q());
        assertThat(stats.exact()).isTrue(); // numbers default to Exact search, so percentiles come from the index
        assertThat(stats.max()).isEqualTo(32000.0);
        assertThat(stats.distribution()).hasSize(24);

        var patterns = query.patterns(id, q());
        assertThat(patterns.stream().mapToLong(p -> p.count()).sum()).isEqualTo(9);

        var minimap = query.minimap(id, q(), List.of());
        assertThat(minimap.total()).isEqualTo(9);
        assertThat(minimap.sampled()).isFalse();
        assertThat(minimap.errors().stream().mapToLong(Long::longValue).sum()).isEqualTo(1);
        var slow = query.minimap(id, q(), List.of(pill(LogQuery.Op.GT, "timeTaken", "10000")));
        assertThat(slow.matches().stream().mapToLong(Long::longValue).sum()).isEqualTo(2);
    }

    @Test
    void redactAtLoadNeverStoresTheSensitiveValue() throws Exception {
        LogStructure s = sources.preview(null, "detail.log").structure();
        List<FieldDef> fields = s.fields().stream().map(f -> f.label().equals("request")
                ? new FieldDef(f.index(), f.path(), f.label(), f.type(), f.typeSource(), f.format(), f.matchRate(), f.invalidCount(),
                f.suggestBoolean(), f.searchMode(), f.role(), true, f.duplicateOf(), f.firstSeenLine(), f.sample()) : f).toList();
        assertThatThrownBy(() -> sources.create("x", RawMode.OFFSET, PrivacyMode.REDACT_AT_LOAD, s.withFields(fields)))
                .isInstanceOf(LogsException.class);
        String id = sources.create("redacted", RawMode.COPY, PrivacyMode.REDACT_AT_LOAD, s.withFields(fields)).source().id();
        LogInput in = sources.add(id, InputKind.SERVER_FILE, "detail.log", null, true, false);
        await(() -> inputStore.get(in.id()).map(i -> i.status() == InputStatus.DONE).orElse(false));
        assertThat(query.lines(id, q(pill(LogQuery.Op.TEXT, null, "anotrav"))).total()).isZero();
        String any = query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).lines().get(0).lineId();
        assertThat(query.line(id, any).raw()).doesNotContain("evilanotravel").contains("[redacted]");
    }

    @Test
    void nodeLinesPageEveryLineAndInvalidValuesAreListable() throws Exception {
        String id = loadSource();
        // IC7 has two lines at its own level (head + sibling): paged one at a time, both reachable, in time order.
        var first = query.nodeLines(id, new LogQuery(List.of(), null, null, null, null, 1), "S1\u0001IC7", false);
        assertThat(first.lines()).extracting(l -> l.fields().get("message")).containsExactly("inbound request");
        var second = query.nodeLines(id, new LogQuery(List.of(), null, null, null, first.nextCursor(), 1), "S1\u0001IC7", false);
        assertThat(second.lines()).extracting(l -> l.fields().get("message")).containsExactly("inbound response");
        assertThat(query.nodeLines(id, q(), "S1", true).lines()).extracting(l -> l.missingLevel()).containsExactly("inboundCallId");

        // A new source keeps every line: no size cap and no age retention.
        assertThat(sources.get(id).source().retentionMaxBytes()).isZero();
        assertThatThrownBy(() -> sources.update(id, null, 5L)).isInstanceOf(LogsException.class);

        LogStructure s = sources.structure(id);
        List<FieldDef> fields = s.fields().stream().map(f -> f.label().equals("tookText")
                ? f.withType(FieldType.NUMBER, "", f.typeSource()) : f).toList(); // "30000ms" does not fit without the unit
        sources.updateStructure(id, s.withFields(fields));
        await(() -> query.invalidValues(id, "tookText").size() == 3);
        assertThat(query.invalidValues(id, "tookText").get(0).fields()).containsKey("tookText");
    }

    @Test
    void loadingTheSameFileTwiceAsksFirst() throws Exception {
        String id = loadSource();
        assertThatThrownBy(() -> sources.add(id, InputKind.SERVER_FILE, "detail.log", null, true, false))
                .isInstanceOf(LogsException.class).hasMessage("DUPLICATE_FILE");
        assertThatThrownBy(() -> sources.add(id, InputKind.SERVER_FILE, "../etc/passwd", null, true, false))
                .isInstanceOf(LogsException.class).hasMessageContaining("server logs folder");
    }

    @Test
    void everyLineKeepsItsOwnStructureRolesFallBackAndAStructureCanMove() throws Exception {
        List<String> a = new ArrayList<>();
        for (int k = 0; k < 6; k++) {
            a.add("{\"@timestamp\":\"2026-10-01T10:00:0" + k + "Z\",\"level\":\"INFO\",\"message\":\"api call " + k
                    + "\",\"service\":\"portal\",\"traceId\":\"T" + (k % 2) + "\"}");
        }
        List<String> b = new ArrayList<>();
        for (int k = 0; k < 4; k++) {
            b.add("{\"event\":{\"time\":\"2026-10-02T09:00:0" + k + "Z\"},\"severity\":\"error\",\"job\":\"nightly\","
                    + "\"records\":" + (k * 10) + ",\"runId\":\"T1\"}");
        }
        List<String> all = new ArrayList<>(a);
        all.addAll(b);
        Files.writeString(dir.resolve("drop").resolve("mixed.log"), String.join("\n", all) + "\n", StandardCharsets.UTF_8);

        // Structure detected from the first structure only: the second one's fields arrive mid-file.
        LogStructure s = sources.preview(a, null).structure();
        String id = sources.create("mixed", RawMode.COPY, PrivacyMode.SHOW, s).source().id();
        LogInput in = sources.add(id, InputKind.SERVER_FILE, "mixed.log", null, true, false);
        await(() -> inputStore.get(in.id()).map(i -> i.status() == InputStatus.DONE).orElse(false));

        assertThat(query.lines(id, q()).total()).isEqualTo(10);
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "job", "nightly"))).total()).isEqualTo(4);
        assertThat(query.lines(id, q(pill(LogQuery.Op.GT, "records", "15"))).total()).isEqualTo(2);
        assertThat(inputStore.get(in.id()).orElseThrow().mismatchCount()).isZero();

        var structures = query.structures(id, q(pill(LogQuery.Op.EQ, "job", "nightly")));
        assertThat(structures.structures()).hasSize(2);
        assertThat(structures.totalLines()).isEqualTo(10);
        assertThat(structures.presence().get("job")).isEqualTo(0.4);
        assertThat(structures.presence().get("service")).isEqualTo(0.6);
        var second = structures.structures().stream().filter(x -> x.fields().contains("job")).findFirst().orElseThrow();
        assertThat(second.lineCount()).isEqualTo(4);
        assertThat(second.matching()).isEqualTo(4);
        assertThat(second.name()).startsWith("with ");
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, LogQuery.STRUCTURE_FIELD, second.code()))).total()).isEqualTo(4);
        assertThat(query.lines(id, q(pill(LogQuery.Op.NEQ, LogQuery.STRUCTURE_FIELD, second.code()))).total()).isEqualTo(6);
        assertThat(query.lines(id, q()).lines()).extracting(l -> l.shape()).containsOnly(second.id(), second.id() == 1 ? 2 : 1);

        // Time, level and correlation listed on two fields each: a line uses the first one it has.
        LogStructure current = sources.structure(id);
        List<FieldDef> roled = current.fields().stream().map(f -> switch (f.label()) {
            case "time" -> f.withType(FieldType.DATETIME, "ISO-8601 · UTC", f.typeSource())
                    .withRole(com.fathy.alfred.backend.logs.domain.model.Role.TIME, 2);
            case "severity" -> f.withRole(com.fathy.alfred.backend.logs.domain.model.Role.LEVEL, 2);
            case "traceId" -> f.withRole(com.fathy.alfred.backend.logs.domain.model.Role.CORRELATION, 1);
            case "runId" -> f.withRole(com.fathy.alfred.backend.logs.domain.model.Role.CORRELATION, 2);
            default -> f;
        }).toList();
        LogStructure saved = sources.updateStructure(id, current.withFields(roled));
        assertThat(saved.rolesOf(com.fathy.alfred.backend.logs.domain.model.Role.TIME)).extracting(FieldDef::label)
                .containsExactly("@timestamp", "time");
        long day2 = java.time.Instant.parse("2026-10-02T00:00:00Z").toEpochMilli();
        await(() -> query.lines(id, new LogQuery(List.of(), day2, null, null, null, 0)).total() == 4);
        await(() -> query.lines(id, q()).lines().stream().filter(l -> "ERROR".equals(l.level())).count() == 4);
        // `level:ERROR` matches what the histogram counts as ERROR - the job lines say it in `severity`,
        // in lower case - and agrees with the sidebar's count for the level field.
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "level", "ERROR"))).total()).isEqualTo(4);
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "level", "error"))).total()).isEqualTo(4);
        assertThat(query.lines(id, q(pill(LogQuery.Op.NEQ, "level", "ERROR"))).total()).isEqualTo(6);
        assertThat(query.lines(id, q(pill(LogQuery.Op.EQ, "severity", "error"))).total()).isEqualTo(4);
        assertThat(query.fieldValues(id, q()).fields().get("level").top())
                .extracting(v -> v.value() + "=" + v.count()).containsExactlyInAnyOrder("INFO=6", "ERROR=4");

        // Sorting by a field: numbers as numbers, lines lacking the field last, paged without gaps.
        List<String> order = new ArrayList<>();
        String cursor = null;
        do {
            var page = query.lines(id, new LogQuery(List.of(), null, null, new LogQuery.Sort("records", false), cursor, 3));
            page.lines().forEach(l -> order.add(String.valueOf(l.fields().get("records"))));
            cursor = page.nextCursor();
        } while (cursor != null);
        assertThat(order).containsExactly("30", "20", "10", "0", "null", "null", "null", "null", "null", "null");
        var ascending = query.lines(id, new LogQuery(List.of(pill(LogQuery.Op.EXISTS, "records", null)), null, null,
                new LogQuery.Sort("records", true), null, 10));
        assertThat(ascending.lines()).extracting(l -> String.valueOf(l.fields().get("records"))).containsExactly("0", "10", "20", "30");
        String bLine = query.lines(id, q(pill(LogQuery.Op.EQ, "job", "nightly"))).lines().get(0).lineId();
        assertThat(query.trace(id, bLine)).hasSize(7); // 3 api calls with T1 + the 4 job lines

        // Move the second structure into a source of its own.
        var moved = sources.moveStructure(id, second.id(), "nightly jobs");
        await(() -> query.lines(moved.source().id(), q()).total() == 4);
        assertThat(query.lines(id, q()).total()).isEqualTo(6);
        assertThat(query.structures(id, null).structures()).hasSize(1);
    }

    @Test
    void linesStoredBeforeStructuresAreSortedInTheBackground() throws Exception {
        String id = loadSource();
        // The state an older ALFRED left: no structures, and lines flagged "different structure".
        org.springframework.jdbc.core.JdbcTemplate jdbc = ReflectionTestUtils.invokeMethod(repository, "jdbc");
        jdbc.update("UPDATE ll_" + id + " SET shape = NULL");
        jdbc.update("UPDATE ll_" + id + " SET mismatch = 1 WHERE line_id IN (SELECT line_id FROM ll_" + id + " WHERE unparsed = 0 LIMIT 2)");
        jdbc.update("DELETE FROM ls_" + id);
        jdbc.update("UPDATE log_input SET mismatch_count = 2 WHERE source_id = ?", id);
        ingest.forgetSource(id);
        assertThat(lineStore.hasUnshaped(id)).isTrue();

        ShapeBackfillService backfill = new ShapeBackfillService(sourceStore, inputStore, lineStore, quiet, ingest);
        backfill.backfill(sources.get(id).source());

        assertThat(lineStore.hasUnshaped(id)).isFalse();
        var structures = query.structures(id, null);
        assertThat(structures.totalLines()).isEqualTo(8);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM ll_" + id + " WHERE mismatch = 1", Long.class)).isZero();
        assertThat(inputStore.bySource(id).get(0).mismatchCount()).isZero();
        assertThat(query.lines(id, q(pill(LogQuery.Op.TEXT, null, "anotrav"))).total()).isEqualTo(8);
    }

    @Test
    void bigPayloadsAreKeptAsOneSearchableFieldNotHundreds() throws Exception {
        List<String> all = new ArrayList<>();
        for (int k = 0; k < 40; k++) {
            StringBuilder bean = new StringBuilder("{");
            for (int f = 0; f < 120; f++) {
                bean.append(f == 0 ? "" : ",").append("\"field").append(f).append("\":\"v").append(k).append('_').append(f).append('"');
            }
            bean.append(",\"priceClasses\":{\"R2FsaWxlbyNFR1kjd1lX").append(k).append("\":{\"fareType\":\"ECO\"}}}");
            all.add("{\"timestamp\":\"2026-10-01T10:00:" + (10 + k) + "Z\",\"level\":\"INFO\",\"message\":{\"methodName\":\"book\","
                    + "\"context\":{\"externalService\":\"Air\",\"response\":{\"bean\":" + bean + "}}}}");
        }
        Files.writeString(dir.resolve("drop").resolve("payload.log"), String.join("\n", all) + "\n", StandardCharsets.UTF_8);

        LogStructure s = sources.preview(null, "payload.log").structure();
        assertThat(s.payloadPaths()).containsExactly("message.context.response.bean");
        assertThat(s.fields()).hasSizeLessThan(10);
        String id = sources.create("payload", RawMode.COPY, PrivacyMode.SHOW, s).source().id();
        LogInput in = sources.add(id, InputKind.SERVER_FILE, "payload.log", null, true, false);
        await(() -> inputStore.get(in.id()).map(i -> i.status() == InputStatus.DONE).orElse(false));

        assertThat(query.lines(id, q()).total()).isEqualTo(40);
        assertThat(sources.structure(id).fields()).hasSizeLessThan(10);
        // The payload is one field holding its JSON - searchable by any fragment, shown in full.
        assertThat(query.lines(id, q(pill(LogQuery.Op.TEXT, null, "v7_119"))).total()).isEqualTo(1);
        assertThat(query.structures(id, null).structures()).hasSize(1);
    }
}
