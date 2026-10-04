package com.fathy.alfred.dbagent.sql;

import com.fathy.alfred.dbagent.transport.Value;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What can be read from SQL text alone: its kind, its first table (or procedure), and a fingerprint (FR-041) - the
 * normalised text plus parameter types, so a later run can match a live statement to its recording. Text only; never
 * executes anything.
 */
public final class SqlShape {

    private static final Pattern COMMENTS = Pattern.compile("(?s)/\\*.*?\\*/|--[^\\n]*");
    private static final Pattern TABLE = Pattern.compile("(?i)\\b(?:FROM|INTO|UPDATE|JOIN|MERGE\\s+INTO)\\s+([\"`\\[]?[A-Za-z0-9_$#.]+[\"`\\]]?)");
    private static final Pattern CALL = Pattern.compile("(?i)^\\{?\\s*(?:\\?\\s*=\\s*)?(?:call|exec|execute)\\s+([A-Za-z0-9_$#.\"]+)");

    private SqlShape() {
    }

    public static String kind(String sql) {
        String s = strip(sql);
        String upper = s.toUpperCase(Locale.ROOT);
        String first = firstWord(upper);
        switch (first) {
            case "SELECT":
            case "VALUES":
            case "SHOW":
            case "EXPLAIN":
                return "SELECT";
            case "INSERT":
            case "UPSERT":
            case "REPLACE":
                return "INSERT";
            case "UPDATE":
                return "UPDATE";
            case "DELETE":
            case "TRUNCATE":
                return "DELETE";
            case "MERGE":
                return "MERGE";
            case "CALL":
            case "EXEC":
            case "EXECUTE":
            case "{CALL":
            case "BEGIN":
            case "DECLARE":
                return "CALL";
            case "CREATE":
            case "ALTER":
            case "DROP":
            case "GRANT":
            case "REVOKE":
            case "COMMENT":
                return "DDL";
            case "COMMIT":
                return "COMMIT";
            case "ROLLBACK":
                return "ROLLBACK";
            case "WITH":
                return withKind(upper);
            default:
                if (upper.startsWith("{") || upper.startsWith("?")) {
                    return "CALL";
                }
                return "OTHER";
        }
    }

    /** A CTE takes the kind of the statement after it. */
    private static String withKind(String upper) {
        int depth = 0;
        for (int i = 0; i < upper.length(); i++) {
            char c = upper.charAt(i);
            if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
            } else if (depth == 0) {
                for (String k : new String[]{"SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"}) {
                    if (upper.startsWith(k, i) && (i == 0 || !Character.isLetterOrDigit(upper.charAt(i - 1)))) {
                        return k;
                    }
                }
            }
        }
        return "SELECT";
    }

    public static String table(String sql) {
        String s = strip(sql);
        Matcher call = CALL.matcher(s);
        if (call.find()) {
            return clean(call.group(1));
        }
        Matcher m = TABLE.matcher(s);
        return m.find() ? clean(m.group(1)) : null;
    }

    public static String fingerprint(String sql, List<Value> firstParams) {
        StringBuilder text = new StringBuilder(normalize(sql));
        for (Value v : firstParams) {
            text.append('|').append(v == null ? "?" : v.type);
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(text.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                hex.append(String.format("%02x", digest[i]));
            }
            return hex.toString();
        } catch (Exception e) {
            return Integer.toHexString(text.toString().hashCode());
        }
    }

    static String normalize(String sql) {
        return strip(sql).replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static String strip(String sql) {
        if (sql == null) {
            return "";
        }
        String s = COMMENTS.matcher(sql).replaceAll(" ").trim();
        while (s.startsWith("(")) {
            s = s.substring(1).trim();
        }
        return s;
    }

    private static String firstWord(String upper) {
        int end = 0;
        while (end < upper.length() && !Character.isWhitespace(upper.charAt(end)) && upper.charAt(end) != '(') {
            end++;
        }
        return upper.substring(0, end);
    }

    private static String clean(String table) {
        String t = table.replaceAll("[\"`\\[\\]]", "");
        return t.isEmpty() ? null : t;
    }
}
