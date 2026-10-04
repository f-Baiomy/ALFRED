package com.fathy.alfred.dbagent.sql;

import java.util.Locale;

/**
 * The parts of a single-table {@code UPDATE ... SET ... WHERE ...} or {@code DELETE FROM ... WHERE ...} the before-image
 * read needs: the table (with its alias, as written), the WHERE text, and which of the statement's {@code ?}s belong
 * to the WHERE. Anything else - joins, subqueries, several tables, UPDATE ... FROM, USING, LIMIT, no WHERE at all - is
 * "too complex": the agent then skips the read and says why, rather than guess which rows a statement touched.
 */
public final class WriteShape {

    /** e.g. "wallet w" - pasted into {@code SELECT * FROM <fromClause> WHERE <where>}. */
    public final String fromClause;
    public final String where;
    /** 0-based index of the first {@code ?} inside the WHERE, among all the statement's placeholders. */
    public final int firstWhereParam;
    public final int whereParamCount;

    private WriteShape(String fromClause, String where, int firstWhereParam, int whereParamCount) {
        this.fromClause = fromClause;
        this.where = where;
        this.firstWhereParam = firstWhereParam;
        this.whereParamCount = whereParamCount;
    }

    /** The shape, or null with {@link #reason} saying why not. */
    public static Result of(String sql) {
        if (sql == null) {
            return Result.skip("no SQL");
        }
        String masked = mask(sql);
        String upper = masked.toUpperCase(Locale.ROOT);
        String trimmed = upper.trim();
        boolean update = trimmed.startsWith("UPDATE ");
        boolean delete = trimmed.startsWith("DELETE ");
        if (!update && !delete) {
            return Result.skip("not an UPDATE or DELETE");
        }
        if (upper.contains("(SELECT") || upper.contains("( SELECT") || containsWord(upper, "JOIN") || containsWord(upper, "USING")
                || containsWord(upper, "LIMIT") || containsWord(upper, "RETURNING") || containsWord(upper, "OUTPUT")) {
            return Result.skip("too complex for a before-image (join, subquery, USING, LIMIT or RETURNING)");
        }
        int where = indexOfWord(upper, "WHERE", 0);
        if (where < 0) {
            return Result.skip("no WHERE - the read would be the whole table");
        }
        String from;
        if (update) {
            int start = upper.indexOf("UPDATE") + "UPDATE".length();
            int set = indexOfWord(upper, "SET", start);
            if (set < 0 || set > where) {
                return Result.skip("not a plain UPDATE ... SET ... WHERE");
            }
            if (indexOfWord(upper, "FROM", set) >= 0 && indexOfWord(upper, "FROM", set) < where) {
                return Result.skip("UPDATE ... FROM reads several tables");
            }
            from = sql.substring(start, set).trim();
        } else {
            int fromAt = indexOfWord(upper, "FROM", 0);
            if (fromAt < 0 || fromAt > where) {
                return Result.skip("not a plain DELETE FROM ... WHERE");
            }
            from = sql.substring(fromAt + "FROM".length(), where).trim();
        }
        if (from.isEmpty() || from.contains(",")) {
            return Result.skip("several tables");
        }
        int before = count(masked.substring(0, where));
        int inWhere = count(masked.substring(where));
        return new Result(new WriteShape(from, sql.substring(where + "WHERE".length()).trim(), before, inWhere), null);
    }

    /** Same length as {@code sql}, string literals, quoted identifiers and comments blanked - so keywords inside them never count. */
    static String mask(String sql) {
        char[] out = sql.toCharArray();
        int i = 0;
        while (i < out.length) {
            char c = out[i];
            if (c == '\'' || c == '"' || c == '`') {
                int j = i + 1;
                while (j < out.length && out[j] != c) {
                    j++;
                }
                for (int k = i + 1; k < Math.min(j, out.length); k++) {
                    out[k] = ' ';
                }
                i = j + 1;
            } else if (c == '-' && i + 1 < out.length && out[i + 1] == '-') {
                while (i < out.length && out[i] != '\n') {
                    out[i++] = ' ';
                }
            } else if (c == '/' && i + 1 < out.length && out[i + 1] == '*') {
                int end = sql.indexOf("*/", i + 2);
                int stop = end < 0 ? out.length : end + 2;
                for (int k = i; k < stop; k++) {
                    out[k] = ' ';
                }
                i = stop;
            } else {
                i++;
            }
        }
        return new String(out);
    }

    private static int count(String masked) {
        int n = 0;
        for (int i = 0; i < masked.length(); i++) {
            if (masked.charAt(i) == '?') {
                n++;
            }
        }
        return n;
    }

    private static boolean containsWord(String upper, String word) {
        return indexOfWord(upper, word, 0) >= 0;
    }

    private static int indexOfWord(String upper, String word, int from) {
        int i = upper.indexOf(word, from);
        while (i >= 0) {
            boolean startOk = i == 0 || !Character.isLetterOrDigit(upper.charAt(i - 1)) && upper.charAt(i - 1) != '_';
            int end = i + word.length();
            boolean endOk = end >= upper.length() || !Character.isLetterOrDigit(upper.charAt(end)) && upper.charAt(end) != '_';
            if (startOk && endOk) {
                return i;
            }
            i = upper.indexOf(word, i + 1);
        }
        return -1;
    }

    public static final class Result {
        public final WriteShape shape;
        public final String reason;

        Result(WriteShape shape, String reason) {
            this.shape = shape;
            this.reason = reason;
        }

        static Result skip(String reason) {
            return new Result(null, reason);
        }
    }
}
