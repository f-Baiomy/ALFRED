package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.CallMarker;
import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlag;
import com.fathy.alfred.backend.dbcapture.domain.model.DbFlagType;
import com.fathy.alfred.backend.dbcapture.domain.model.MarkerType;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementTransaction;
import com.fathy.alfred.backend.dbcapture.domain.model.Thresholds;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The problems the database window flags in one call (FR-023) - computed from what was captured, never by asking the
 * database. Pure: statements, transactions and supplier-call markers in, flags out, worst first (the mock's order).
 * A statement shape the user marked expected raises nothing.
 */
public final class StatementFlags {

    /**
     * Bumped whenever the rules change: a call whose stored flags have an older version is flagged again the first time
     * it is read (DbCaptureQueryService), so old captures get the new rules without being captured again.
     */
    public static final int VERSION = 2;
    /** The HQL kinds whose execution is one query of the code's - an event (lazy load, flush) is not. */
    private static final Set<String> QUERY_ORIGINS = Set.of("HQL", "CRITERIA", "NATIVE");
    /** Per-row pattern without an origin: the first statement's rows, and the follow-up queries per row, looked for. */
    private static final int MAX_PATTERN_ROWS = 500;
    private static final int MAX_PER_ROW = 5;

    /** One flag per statement would bury the important ones in a busy call; past this, a type stops adding more. */
    static final int MAX_PER_TYPE = 20;
    private static final Pattern STRINGS_AND_COMMENTS = Pattern.compile("'(?:[^']|'')*'|\"[^\"]*\"|--[^\\n]*|/\\*.*?\\*/", Pattern.DOTALL);
    private static final Pattern WHERE = Pattern.compile("(?i)\\bWHERE\\b");
    private static final Pattern FOR_UPDATE = Pattern.compile("(?i)\\bFOR\\s+UPDATE\\b");

    private StatementFlags() {
    }

    public static List<DbFlag> compute(List<CapturedStatement> statements, List<StatementTransaction> transactions, List<CallMarker> markers,
                                       DbCaptureSettings settings) {
        Thresholds t = settings.thresholds() == null ? Thresholds.DEFAULTS : settings.thresholds();
        Set<String> expected = new HashSet<>(settings.expectedFingerprints() == null ? List.of() : settings.expectedFingerprints());
        List<CapturedStatement> ordered = statements.stream().sorted(Comparator.comparingInt(CapturedStatement::seq)).toList();
        List<CapturedStatement> flaggable = ordered.stream().filter(s -> s.fingerprint() == null || !expected.contains(s.fingerprint())).toList();

        List<DbFlag> flags = new ArrayList<>();
        for (CapturedStatement s : flaggable) {
            boolean write = s.kind() == StatementKind.DELETE || s.kind() == StatementKind.UPDATE;
            if (write && s.outcome().kind() != OutcomeKind.FAILED && !WHERE.matcher(withoutLiterals(s.sql())).find()) {
                flags.add(flag(DbFlagType.NO_WHERE, DbFlag.BAD, s, null, detail("verb", s.kind().name(), "table", s.table(), "rows", affected(s))));
            }
        }
        for (CapturedStatement s : flaggable) {
            if (s.outcome().kind() == OutcomeKind.FAILED) {
                boolean swallowed = Boolean.TRUE.equals(s.outcome().swallowed());
                flags.add(flag(swallowed ? DbFlagType.FAILED_SWALLOWED : DbFlagType.FAILED, DbFlag.BAD, s, null,
                        detail("error", errorLabel(s), "table", s.table())));
            }
        }
        for (StatementTransaction tx : transactions) {
            if (StatementTransaction.ROLLED_BACK.equals(tx.outcome()) && tx.writeCount() > 0) {
                flags.add(new DbFlag(DbFlagType.ROLLED_BACK, DbFlag.BAD, List.of(tx.firstSeq()), tx.txId(),
                        detail("tx", tx.txId(), "writes", String.valueOf(tx.writeCount()))));
            }
        }
        flags.addAll(locksDuringSupplierCalls(ordered, transactions, markers));
        for (CapturedStatement s : flaggable) {
            if (s.kind() == StatementKind.DELETE && s.outcome().affected() != null && s.outcome().affected() > t.largeDeleteRows()) {
                flags.add(flag(DbFlagType.LARGE_DELETE, DbFlag.WARN, s, null, detail("table", s.table(), "rows", affected(s))));
            }
        }
        for (CapturedStatement s : flaggable) {
            if (s.kind() == StatementKind.DELETE && s.cascadesTo() != null && !s.cascadesTo().isEmpty() && s.outcome().kind() != OutcomeKind.FAILED) {
                flags.add(flag(DbFlagType.CASCADE, DbFlag.WARN, s, null, detail("table", s.table(), "children", String.join(", ", s.cascadesTo()))));
            }
        }
        List<CapturedStatement> blind = flaggable.stream()
                .filter(s -> (s.kind() == StatementKind.DELETE || s.kind() == StatementKind.UPDATE) && s.outcome().kind() != OutcomeKind.FAILED)
                .filter(s -> s.beforeImage() == null || BeforeImage.NONE.equals(s.beforeImage().source()))
                .toList();
        if (!blind.isEmpty()) {
            long deletes = blind.stream().filter(s -> s.kind() == StatementKind.DELETE).count();
            flags.add(new DbFlag(DbFlagType.BEFORE_NOT_CAPTURED, DbFlag.WARN, blind.stream().map(CapturedStatement::seq).toList(), null,
                    detail("count", String.valueOf(blind.size()), "deletes", String.valueOf(deletes), "updates", String.valueOf(blind.size() - deletes))));
        }
        Set<Integer> inCacheableRuns = new HashSet<>();
        flags.addAll(repeats(ordered, expected, t.repeatCount(), inCacheableRuns));
        flags.addAll(duplicates(flaggable.stream().filter(s -> !inCacheableRuns.contains(s.seq())).toList()));
        List<DbFlag> fanOuts = fanOuts(ordered, expected);
        flags.addAll(fanOuts);
        // A statement of a fan-out is reported there, with the time all of them together cost - not as slow on its own.
        Set<Integer> inFanOuts = new HashSet<>();
        fanOuts.forEach(f -> inFanOuts.addAll(f.seqs()));
        flags.addAll(transactionPerStatement(ordered, transactions));
        // Slow for the time spent BEYOND the round trip every statement of this call pays (RoundTrip).
        long baseline = RoundTrip.baselineMicros(ordered);
        for (CapturedStatement s : flaggable) {
            if (s.durationMicros() - baseline > t.slowMs() * 1000L && !inFanOuts.contains(s.seq()) && s.kind() != StatementKind.COMMIT && s.kind() != StatementKind.ROLLBACK) {
                flags.add(flag(DbFlagType.SLOW, DbFlag.WARN, s, null, detail("ms", String.valueOf(Math.round(s.durationMicros() / 1000.0)), "table", s.table(),
                        "baselineMs", baseline > 0 ? String.valueOf(Math.round(baseline / 1000.0)) : null)));
            }
        }
        for (CapturedStatement s : flaggable) {
            Long read = s.outcome().rowsRead();
            if (read != null && read > t.hugeRows()) {
                flags.add(flag(DbFlagType.HUGE_RESULT, DbFlag.WARN, s, null, detail("rows", String.format("%,d", read), "table", s.table())));
            }
        }
        return capPerType(flags);
    }

    /**
     * The same SQL with the same parameters run more than once anywhere in the call (not only back to back, unlike
     * REPEATED_QUERY): one flag per statement shape, naming every repeat. Statements inside a back-to-back run already
     * flagged "cacheable" are left out, so the same problem is not reported twice.
     */
    private static List<DbFlag> duplicates(List<CapturedStatement> flaggable) {
        Map<String, List<CapturedStatement>> byShapeAndParams = new LinkedHashMap<>();
        for (CapturedStatement s : flaggable) {
            String shape = shapeOf(s);
            if (shape == null || s.params().size() > 1 || s.outcome().kind() == OutcomeKind.FAILED) {
                continue; // a batch is one round trip already; a failure is flagged on its own
            }
            byShapeAndParams.computeIfAbsent(shape + "\u0000" + s.params(), k -> new ArrayList<>()).add(s);
        }
        Map<String, List<List<CapturedStatement>>> byShape = new LinkedHashMap<>();
        for (List<CapturedStatement> same : byShapeAndParams.values()) {
            if (same.size() > 1) {
                byShape.computeIfAbsent(shapeOf(same.get(0)), k -> new ArrayList<>()).add(same);
            }
        }
        List<DbFlag> out = new ArrayList<>();
        for (Map.Entry<String, List<List<CapturedStatement>>> e : byShape.entrySet()) {
            List<CapturedStatement> all = e.getValue().stream().flatMap(List::stream).sorted(Comparator.comparingInt(CapturedStatement::seq)).toList();
            int extra = e.getValue().stream().mapToInt(group -> group.size() - 1).sum();
            out.add(new DbFlag(DbFlagType.DUPLICATE, DbFlag.WARN, all.stream().map(CapturedStatement::seq).toList(), e.getKey(),
                    detail("table", all.get(0).table(), "duplicates", String.valueOf(extra), "values", String.valueOf(e.getValue().size()))));
        }
        return out;
    }

    /**
     * An N+1 inside one query: its rows each triggered more queries. By origin - every SQL statement of one HQL/native
     * execution shares its id; 3 or more, with the follow-ups bound to 2 or more different values (one per parent row).
     * Without an origin (plain JDBC, or an agent without Hibernate support) - a SELECT returning R rows followed by R
     * cycles of the same 1-5 tables, each cycle bound to different values.
     */
    private static List<DbFlag> fanOuts(List<CapturedStatement> ordered, Set<String> expected) {
        List<DbFlag> out = new ArrayList<>();
        Set<Integer> used = new HashSet<>();
        Map<String, List<CapturedStatement>> byExecution = new LinkedHashMap<>();
        for (CapturedStatement s : ordered) {
            // A query's own SQL carries its id; a load it caused (LAZY_LOAD, LOAD) names it as parentId instead.
            String execution = s.origin() == null ? null
                    : s.origin().parentId() != null ? s.origin().parentId()
                    : QUERY_ORIGINS.contains(s.origin().kind()) ? s.origin().id() : null;
            if (execution != null && shapeOf(s) != null) {
                byExecution.computeIfAbsent(execution, k -> new ArrayList<>()).add(s);
            }
        }
        for (List<CapturedStatement> execution : byExecution.values()) {
            if (execution.size() < 3) {
                continue;
            }
            CapturedStatement first = execution.get(0);
            if (first.origin().parentId() != null) {
                continue; // the query's own SQL was not captured
            }
            List<CapturedStatement> followers = execution.subList(1, execution.size());
            long parents = followers.stream().map(CapturedStatement::params).distinct().count();
            if (parents < 2 || isExpected(first, expected)) {
                continue;
            }
            out.add(fanOut(first, followers, first.origin().id(), first.origin().text()));
            execution.forEach(s -> used.add(s.seq()));
        }
        for (int i = 0; i < ordered.size(); i++) {
            CapturedStatement first = ordered.get(i);
            Long read = first.outcome().rowsRead();
            if (first.origin() != null || used.contains(first.seq()) || first.kind() != StatementKind.SELECT || read == null
                    || read < 2 || read > MAX_PATTERN_ROWS || isExpected(first, expected)) {
                continue;
            }
            int rows = (int) (long) read;
            for (int perRow = 1; perRow <= MAX_PER_ROW; perRow++) {
                int need = rows * perRow;
                if (i + need >= ordered.size()) {
                    break;
                }
                List<CapturedStatement> window = ordered.subList(i + 1, i + 1 + need);
                CapturedStatement after = i + 1 + need < ordered.size() ? ordered.get(i + 1 + need) : null;
                if (perRowPattern(first, window, perRow) && (after == null || !Objects.equals(shapeOf(after), shapeOf(window.get(0))))) {
                    out.add(fanOut(first, window, "seq:" + first.seq(), null));
                    window.forEach(s -> used.add(s.seq()));
                    used.add(first.seq());
                    i += need;
                    break;
                }
            }
        }
        return out;
    }

    /** {@code window} is one cycle per row of {@code first}: the same {@code perRow} other queries, each cycle bound to different values. */
    private static boolean perRowPattern(CapturedStatement first, List<CapturedStatement> window, int perRow) {
        // The same query again with other values is a repeat (REPEATED_QUERY), not rows loading their children.
        if (window.stream().anyMatch(s -> Objects.equals(shapeOf(s), shapeOf(first)))) {
            return false;
        }
        for (int j = 0; j < window.size(); j++) {
            CapturedStatement s = window.get(j);
            CapturedStatement model = window.get(j % perRow);
            if (shapeOf(s) == null || s.origin() != null || s.kind() != StatementKind.SELECT || !Objects.equals(shapeOf(s), shapeOf(model))) {
                return false;
            }
        }
        Set<List<List<TypedValue>>> cycles = new HashSet<>();
        for (int c = 0; c < window.size(); c += perRow) {
            cycles.add(window.get(c).params());
        }
        return cycles.size() == window.size() / perRow;
    }

    private static DbFlag fanOut(CapturedStatement first, List<CapturedStatement> followers, String group, String queryText) {
        List<Integer> seqs = new ArrayList<>();
        seqs.add(first.seq());
        followers.forEach(s -> seqs.add(s.seq()));
        long parents = followers.stream().map(CapturedStatement::params).distinct().count();
        long extraMicros = followers.stream().mapToLong(CapturedStatement::durationMicros).sum();
        List<String> tables = followers.stream().map(CapturedStatement::table).filter(Objects::nonNull).distinct().toList();
        long perRow = parents == 0 ? 0 : Math.round((double) followers.size() / parents);
        String query = queryText != null ? queryText : first.sql();
        return new DbFlag(DbFlagType.QUERY_FAN_OUT, DbFlag.WARN, seqs, group, detail(
                "query", query == null ? null : query.length() > 200 ? query.substring(0, 200) + "…" : query,
                "table", first.table(),
                "rows", first.outcome().rowsRead() == null ? null : String.valueOf(first.outcome().rowsRead()),
                "statements", String.valueOf(seqs.size()),
                "extra", String.valueOf(followers.size()),
                "parents", String.valueOf(parents),
                "perRow", String.valueOf(perRow),
                "tables", String.join(", ", tables),
                "extraMs", String.valueOf(Math.round(extraMicros / 1000.0))));
    }

    private static boolean isExpected(CapturedStatement s, Set<String> expected) {
        return s.fingerprint() != null && expected.contains(s.fingerprint());
    }

    /** Ten or more transactions, about one per statement: the per-transaction cost (checkout, begin, commit) dominates. */
    private static List<DbFlag> transactionPerStatement(List<CapturedStatement> ordered, List<StatementTransaction> transactions) {
        long statements = ordered.stream().filter(s -> shapeOf(s) != null).count();
        long txs = transactions.stream().filter(tx -> tx.statementCount() > 0).count();
        if (txs < 10 || txs * 2 < statements) {
            return List.of();
        }
        return List.of(new DbFlag(DbFlagType.TX_PER_STATEMENT, DbFlag.WARN, List.of(transactions.get(0).firstSeq()), null,
                detail("transactions", String.valueOf(txs), "statements", String.valueOf(statements))));
    }

    /** A supplier call made while this call's transaction held row locks (it had written, or read FOR UPDATE). */
    private static List<DbFlag> locksDuringSupplierCalls(List<CapturedStatement> ordered, List<StatementTransaction> transactions,
                                                         List<CallMarker> markers) {
        List<DbFlag> out = new ArrayList<>();
        for (StatementTransaction tx : transactions) {
            for (CallMarker m : markers) {
                if (m.type() != MarkerType.HTTP_OUT || m.seq() <= tx.firstSeq() || m.seq() >= tx.lastSeq()) {
                    continue;
                }
                boolean locking = ordered.stream().anyMatch(s -> Objects.equals(s.txId(), tx.txId()) && s.seq() < m.seq()
                        && (isWrite(s) || FOR_UPDATE.matcher(s.sql()).find()));
                if (locking) {
                    out.add(new DbFlag(DbFlagType.LOCK_DURING_SUPPLIER_CALL, DbFlag.WARN, List.of(m.seq()), tx.txId(),
                            detail("tx", tx.txId(), "url", m.url())));
                    break; // one per transaction
                }
            }
        }
        return out;
    }

    /** Runs of the same statement shape, back to back - N+1 when the parameters differ, "cacheable" when they do not. */
    private static List<DbFlag> repeats(List<CapturedStatement> ordered, Set<String> expected, int threshold, Set<Integer> inCacheableRuns) {
        List<DbFlag> out = new ArrayList<>();
        int i = 0;
        while (i < ordered.size()) {
            CapturedStatement first = ordered.get(i);
            String shape = shapeOf(first);
            int j = i + 1;
            if (shape != null) {
                while (j < ordered.size() && shape.equals(shapeOf(ordered.get(j)))) {
                    j++;
                }
            }
            int count = j - i;
            if (shape != null && count >= Math.max(2, threshold) && (first.fingerprint() == null || !expected.contains(first.fingerprint()))) {
                List<CapturedStatement> run = ordered.subList(i, j);
                boolean sameParams = run.stream().map(CapturedStatement::params).distinct().count() == 1;
                if (sameParams) {
                    run.forEach(s -> inCacheableRuns.add(s.seq())); // already "cacheable" - not a DUPLICATE as well
                }
                out.add(new DbFlag(DbFlagType.REPEATED_QUERY, DbFlag.WARN, List.of(first.seq()), shape,
                        detail("table", first.table(), "count", String.valueOf(count), "cacheable", String.valueOf(sameParams))));
                i = j;
            } else {
                i++;
            }
        }
        return out;
    }

    private static String shapeOf(CapturedStatement s) {
        if (s.kind() == StatementKind.COMMIT || s.kind() == StatementKind.ROLLBACK) {
            return null;
        }
        return s.fingerprint() != null ? s.fingerprint() : s.sql();
    }

    private static boolean isWrite(CapturedStatement s) {
        return s.kind() == StatementKind.INSERT || s.kind() == StatementKind.UPDATE || s.kind() == StatementKind.DELETE
                || s.kind() == StatementKind.MERGE;
    }

    private static String withoutLiterals(String sql) {
        return STRINGS_AND_COMMENTS.matcher(sql == null ? "" : sql).replaceAll(" ");
    }

    private static String affected(CapturedStatement s) {
        return s.outcome().affected() == null ? null : String.format("%,d", s.outcome().affected());
    }

    private static String errorLabel(CapturedStatement s) {
        String message = s.outcome().message();
        if (message != null) {
            java.util.regex.Matcher m = Pattern.compile("\\b([A-Z]{2,4}-\\d{3,5})\\b").matcher(message);
            if (m.find()) {
                return m.group(1);
            }
        }
        return s.outcome().sqlState() != null ? s.outcome().sqlState() : "error";
    }

    private static DbFlag flag(DbFlagType type, String severity, CapturedStatement s, String group, Map<String, String> detail) {
        return new DbFlag(type, severity, List.of(s.seq()), group, detail);
    }

    /** Key/value pairs, nulls dropped - the label only shows what is known. */
    private static Map<String, String> detail(String... kv) {
        Map<String, String> map = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (kv[i + 1] != null) {
                map.put(kv[i], kv[i + 1]);
            }
        }
        return map;
    }

    private static List<DbFlag> capPerType(List<DbFlag> flags) {
        Map<DbFlagType, Integer> counts = new LinkedHashMap<>();
        List<DbFlag> out = new ArrayList<>();
        for (DbFlag f : flags) {
            int n = counts.merge(f.type(), 1, Integer::sum);
            if (n <= MAX_PER_TYPE) {
                out.add(f);
            }
        }
        return out;
    }
}
