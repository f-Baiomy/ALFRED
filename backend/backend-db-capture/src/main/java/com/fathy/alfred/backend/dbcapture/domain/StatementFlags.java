package com.fathy.alfred.backend.dbcapture.domain;

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
 * A statement shape the user marked expected raises nothing. Before-image flags (CASCADE, BEFORE_NOT_CAPTURED)
 * belong to User Story 4 and are added there.
 */
public final class StatementFlags {

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
        flags.addAll(repeats(ordered, expected, t.repeatCount()));
        for (CapturedStatement s : flaggable) {
            if (s.durationMicros() > t.slowMs() * 1000L && s.kind() != StatementKind.COMMIT && s.kind() != StatementKind.ROLLBACK) {
                flags.add(flag(DbFlagType.SLOW, DbFlag.WARN, s, null, detail("ms", String.valueOf(Math.round(s.durationMicros() / 1000.0)), "table", s.table())));
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
    private static List<DbFlag> repeats(List<CapturedStatement> ordered, Set<String> expected, int threshold) {
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
