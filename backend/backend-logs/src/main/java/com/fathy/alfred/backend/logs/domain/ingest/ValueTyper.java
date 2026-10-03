package com.fathy.alfred.backend.logs.domain.ingest;

import com.fathy.alfred.backend.logs.domain.model.FieldType;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Converts a field's original value to its typed form (FR-011): epoch milliseconds for dates and
 * datetimes, a double for numbers, 0/1 for booleans. A value that does not fit returns empty -
 * never throws - so the caller keeps the original text and counts it as invalid (FR-012).
 *
 * <p>Format strings are what the structure editor shows: dates {@code "<pattern> · <zone>"}
 * ({@code "ISO-8601 · UTC"}, {@code "yyyy-MM-dd (EEEE)"}), numbers {@code "unit: ms"}, booleans
 * {@code "<true word> = true · <false word> = false"}.
 */
public final class ValueTyper {

    static final Pattern ISO_DATETIME = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:?\\d{2})?$");
    static final Pattern ISO_DATE_PREFIX = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern NUMBER = Pattern.compile("^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$");
    private static final String SEP = "·";

    private ValueTyper() {
    }

    public static Optional<Object> convert(Object value, FieldType type, String format) {
        if (value == null || type == FieldType.STRING) {
            return Optional.empty();
        }
        String text = value instanceof String s ? s.strip() : String.valueOf(value);
        if (text.isEmpty()) {
            return Optional.empty();
        }
        try {
            return switch (type) {
                case NUMBER -> number(value, text, format);
                case BOOLEAN -> bool(value, text, format);
                case DATETIME -> datetime(value, text, format);
                case DATE -> date(text, format);
                case STRING -> Optional.empty();
            };
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    public static boolean looksIsoDatetime(Object v) {
        return v instanceof String s && ISO_DATETIME.matcher(s.strip()).matches();
    }

    public static boolean looksIsoDate(Object v) {
        return v instanceof String s && ISO_DATE_PREFIX.matcher(s.strip()).find() && !looksIsoDatetime(v);
    }

    public static boolean looksNumber(Object v) {
        return v instanceof Number || (v instanceof String s && NUMBER.matcher(s.strip()).matches());
    }

    private static Optional<Object> number(Object value, String text, String format) {
        if (value instanceof Number n) {
            return Optional.of(n.doubleValue());
        }
        String unit = unitOf(format);
        String t = unit != null && text.endsWith(unit) ? text.substring(0, text.length() - unit.length()).strip() : text;
        return NUMBER.matcher(t).matches() ? Optional.of(Double.parseDouble(t)) : Optional.empty();
    }

    private static Optional<Object> bool(Object value, String text, String format) {
        if (value instanceof Boolean b) {
            return Optional.of(b ? 1L : 0L);
        }
        String trueWord = "true";
        String falseWord = "false";
        if (format != null && format.contains("=")) {
            for (String part : format.split(SEP)) {
                String[] kv = part.split("=");
                if (kv.length == 2 && kv[1].strip().equalsIgnoreCase("true")) {
                    trueWord = kv[0].strip();
                } else if (kv.length == 2 && kv[1].strip().equalsIgnoreCase("false")) {
                    falseWord = kv[0].strip();
                }
            }
        }
        if (text.equalsIgnoreCase(trueWord) || text.equalsIgnoreCase("true") || text.equals("1")) {
            return Optional.of(1L);
        }
        if (text.equalsIgnoreCase(falseWord) || text.equalsIgnoreCase("false") || text.equals("0")) {
            return Optional.of(0L);
        }
        return Optional.empty();
    }

    private static Optional<Object> datetime(Object value, String text, String format) {
        ZoneId zone = zoneOf(format);
        String pattern = patternOf(format);
        if (value instanceof Number n || NUMBER.matcher(text).matches()) {
            double d = value instanceof Number n2 ? n2.doubleValue() : Double.parseDouble(text);
            // Epoch: below ~1e11 it can only be seconds (1e11 s is the year 5138), above it milliseconds.
            return Optional.of(d < 1e11 ? (long) (d * 1000) : (long) d);
        }
        if (pattern != null) {
            return Optional.of(LocalDateTime.parse(text, DateTimeFormatter.ofPattern(pattern, Locale.ROOT))
                    .atZone(zone).toInstant().toEpochMilli());
        }
        String t = text.replace(' ', 'T');
        if (t.endsWith("Z")) {
            return Optional.of(Instant.parse(t).toEpochMilli());
        }
        if (t.matches(".*[+-]\\d{2}:?\\d{2}$")) {
            String withColon = t.replaceAll("([+-]\\d{2})(\\d{2})$", "$1:$2");
            return Optional.of(OffsetDateTime.parse(withColon).toInstant().toEpochMilli());
        }
        return Optional.of(LocalDateTime.parse(t).atZone(zone).toInstant().toEpochMilli());
    }

    private static Optional<Object> date(String text, String format) {
        ZoneId zone = zoneOf(format);
        String pattern = patternOf(format);
        LocalDate d;
        if (pattern != null) {
            try {
                d = LocalDate.parse(text, DateTimeFormatter.ofPattern(pattern, Locale.ROOT));
            } catch (RuntimeException e) {
                // Patterns with a weekday in another case ("THURSDAY") or decoration still carry an
                // ISO date at the front - fall back to it rather than calling the value invalid.
                if (!ISO_DATE_PREFIX.matcher(text).find()) {
                    throw e;
                }
                d = LocalDate.parse(text.substring(0, 10));
            }
        } else {
            if (!ISO_DATE_PREFIX.matcher(text).find()) {
                return Optional.empty();
            }
            d = LocalDate.parse(text.substring(0, 10));
        }
        return Optional.of(d.atStartOfDay(zone).toInstant().toEpochMilli());
    }

    /** "ISO-8601 · UTC" → null (ISO), "yyyy-MM-dd HH:mm · Asia/Dubai" → the pattern. */
    static String patternOf(String format) {
        if (format == null || format.isBlank()) {
            return null;
        }
        String p = format.split(SEP)[0].strip();
        return p.isEmpty() || p.toUpperCase(Locale.ROOT).startsWith("ISO") ? null : p;
    }

    static ZoneId zoneOf(String format) {
        if (format != null && format.contains(SEP)) {
            String z = format.substring(format.indexOf(SEP) + 1).strip();
            try {
                return ZoneId.of(z);
            } catch (RuntimeException ignored) {
                return ZoneOffset.UTC;
            }
        }
        return ZoneOffset.UTC;
    }

    private static String unitOf(String format) {
        if (format == null || !format.toLowerCase(Locale.ROOT).startsWith("unit:")) {
            return null;
        }
        String u = format.substring(5).strip();
        return u.isEmpty() ? null : u;
    }
}
