package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.BeforeImage;
import com.fathy.alfred.backend.dbcapture.domain.model.Column;
import com.fathy.alfred.backend.dbcapture.domain.model.OutcomeKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementKind;
import com.fathy.alfred.backend.dbcapture.domain.model.StatementOutcome;
import com.fathy.alfred.backend.dbcapture.domain.model.TypedValue;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where an UPDATE's or DELETE's "before" rows come from when the agent did not read them itself (research D12): the
 * latest earlier SELECT in the same call on the same table that read the same rows - same WHERE, or a WHERE whose
 * every simple condition ({@code col = ?}, {@code col = literal}) the write also has, with the same values. Nothing
 * else is guessed: no match means "not captured", and the window says so.
 */
public final class DeletedRowsResolver {

    /** What the resolver needs from an earlier statement - stored or arriving in the same batch. */
    public record Read(int seq, StatementKind kind, String sql, String table, List<TypedValue> params, StatementOutcome outcome, long storedRows) {
    }

    private static final Pattern STRINGS = Pattern.compile("'(?:[^']|'')*'");
    private static final Pattern TAIL = Pattern.compile("(?i)\\b(ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|FETCH|FOR\\s+UPDATE|FOR\\s+SHARE|RETURNING)\\b");
    private static final Pattern WHERE = Pattern.compile("(?i)\\bWHERE\\b");
    private static final Pattern CONDITION = Pattern.compile("(?i)^\\s*(?:[A-Za-z_][\\w$#]*\\.)?\"?([A-Za-z_][\\w$#]*)\"?\\s*=\\s*(\\?|'(?:[^']|'')*'|-?\\d+(?:\\.\\d+)?)\\s*$");

    private DeletedRowsResolver() {
    }

    /** The before-image for {@code write}, from the latest matching earlier read, or null when none matches. */
    public static BeforeImage resolve(String writeSql, String writeTable, List<TypedValue> writeParams, List<Read> earlier) {
        Where write = where(writeSql, writeParams);
        if (write == null || writeTable == null) {
            return null;
        }
        for (int i = earlier.size() - 1; i >= 0; i--) {
            Read read = earlier.get(i);
            if (read.kind() != StatementKind.SELECT || read.outcome() == null || read.outcome().kind() != OutcomeKind.ROWS
                    || read.storedRows() <= 0 || !writeTable.equalsIgnoreCase(Objects.toString(read.table(), ""))) {
                continue;
            }
            Where select = where(read.sql(), read.params());
            if (select != null && covers(select, write)) {
                List<Column> columns = read.outcome().columns();
                return new BeforeImage(BeforeImage.EARLIER_READ, read.seq(), null, null, (int) read.storedRows(), columns);
            }
        }
        return null;
    }

    /** True when every condition the read used is also on the write, with the same value (or the WHERE is identical). */
    private static boolean covers(Where select, Where write) {
        if (select.normalized.equals(write.normalized) && select.values.equals(write.values)) {
            return true;
        }
        if (select.conditions == null || write.conditions == null || select.conditions.isEmpty()) {
            return false;
        }
        return write.conditions.containsAll(select.conditions);
    }

    private record Where(String normalized, List<String> values, List<String> conditions) {
    }

    /** The WHERE of a statement: normalised text, the values bound inside it, and its simple AND-ed conditions (or null if not simple). */
    static Where where(String sql, List<TypedValue> params) {
        if (sql == null) {
            return null;
        }
        String masked = STRINGS.matcher(sql).replaceAll(m -> " ".repeat(m.group().length()));
        Matcher w = WHERE.matcher(masked);
        if (!w.find()) {
            return null;
        }
        int start = w.end();
        Matcher tail = TAIL.matcher(masked);
        int end = tail.find(start) ? tail.start() : sql.length();
        int paramsBefore = count(masked.substring(0, start));
        String text = sql.substring(start, end).trim();
        String maskedText = masked.substring(start, end);
        int inWhere = count(maskedText);
        List<String> values = new ArrayList<>();
        for (int i = 0; i < inWhere; i++) {
            int index = paramsBefore + i;
            values.add(params != null && index < params.size() && params.get(index) != null ? Objects.toString(params.get(index).value()) : "?");
        }
        return new Where(text.replaceAll("\\s+", " ").toLowerCase(Locale.ROOT), values, conditions(text, values));
    }

    private static List<String> conditions(String whereText, List<String> values) {
        String upper = STRINGS.matcher(whereText).replaceAll("''").toUpperCase(Locale.ROOT);
        if (upper.contains(" OR ") || upper.contains("(")) {
            return null;
        }
        List<String> out = new ArrayList<>();
        int param = 0;
        for (String part : whereText.split("(?i)\\s+AND\\s+")) {
            Matcher m = CONDITION.matcher(part);
            if (!m.matches()) {
                return null;
            }
            String value = m.group(2).equals("?") ? (param < values.size() ? values.get(param++) : "?") : unquote(m.group(2));
            out.add(m.group(1).toLowerCase(Locale.ROOT) + "=" + value);
        }
        return out;
    }

    private static String unquote(String literal) {
        return literal.startsWith("'") ? literal.substring(1, literal.length() - 1).replace("''", "'") : literal;
    }

    private static int count(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '?') {
                n++;
            }
        }
        return n;
    }
}
