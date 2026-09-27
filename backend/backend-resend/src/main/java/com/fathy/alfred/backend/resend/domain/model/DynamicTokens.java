package com.fathy.alfred.backend.resend.domain.model;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dynamic {@code {{$...}}} tokens - contracts.md section 4 (D4). A line-for-line port of the
 * frontend's {@code shared/utils/dynamic-tokens.ts} (owner: lead) so a token resolves identically
 * whether it is previewed there, resent here, or matched live by the proxy. All three
 * implementations are held to {@code specs/002-power-features/dynamic-token-vectors.json} - see
 * {@code DynamicTokensVectorTest}.
 *
 * <p>Resolved per use, never at rule-load time: {@code $now}, {@code $uuid} and
 * {@code $randomInt} are different on every call, which is the point of them. Anything the
 * grammar does not recognise (an unknown function, an offset on anything but {@code $now}, a
 * malformed argument) is left exactly as written rather than replaced with an empty string, so a
 * typo is visible in the sent request instead of silently vanishing.
 */
public final class DynamicTokens {

    /**
     * The function-name group is {@code [A-Za-z][A-Za-z0-9]*}, not {@code [A-Za-z]+} - otherwise
     * {@code $base64} (a name containing digits) could never match at all.
     */
    private static final Pattern TOKEN =
            Pattern.compile("\\{\\{\\$([A-Za-z][A-Za-z0-9]*)((?:[+-]\\d{1,6}[smhd])?)(?::([^{}]*))?}}");

    private static final long RANDOM_LIMIT = 1_000_000_000_000L; // 10^12
    private static final Map<Character, Long> OFFSET_MS = Map.of('s', 1000L, 'm', 60_000L, 'h', 3_600_000L, 'd', 86_400_000L);
    private static final Pattern NOW_PATTERN_LETTERS = Pattern.compile("yyyy|SSS|MM|dd|HH|mm|ss");

    private DynamicTokens() {
    }

    /**
     * @param lookup resolves a global variable name for {@code $base64:name}; {@code null} for an
     *               unknown name leaves the token literal, matching an unresolved {@code {{name}}}.
     * @param clock  the source of "now" for {@code $now} - injectable so tests (and the shared
     *               vector file) can pin it.
     */
    public static String resolve(String text, Function<String, String> lookup, Clock clock) {
        if (text == null || !text.contains("{{$")) {
            return text;
        }
        Matcher matcher = TOKEN.matcher(text);
        StringBuilder out = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            out.append(text, last, matcher.start());
            last = matcher.end();
            String arg = matcher.group(3);
            String resolved = resolveOne(matcher.group(1), matcher.group(2), arg, arg != null, lookup, clock);
            out.append(resolved != null ? resolved : matcher.group());
        }
        out.append(text, last, text.length());
        return out.toString();
    }

    private static String resolveOne(String fn, String offset, String arg, boolean argPresent,
                                     Function<String, String> lookup, Clock clock) {
        if (fn.equals("now")) {
            long ms = clock.millis();
            if (offset != null && !offset.isEmpty()) {
                long amount = Long.parseLong(offset.substring(0, offset.length() - 1));
                char unit = offset.charAt(offset.length() - 1);
                ms += amount * OFFSET_MS.get(unit);
            }
            return formatNow(Instant.ofEpochMilli(ms), argPresent ? arg : null);
        }
        // Only $now takes an offset; anything else with one stays literal.
        if (offset != null && !offset.isEmpty()) {
            return null;
        }
        if (fn.equals("uuid")) {
            return argPresent ? null : UUID.randomUUID().toString();
        }
        if (fn.equals("randomInt")) {
            String[] parts = (argPresent ? arg : "").split(":", -1);
            if (parts.length != 2 || !parts[0].matches("-?\\d+") || !parts[1].matches("-?\\d+")) {
                return null;
            }
            long min = Long.parseLong(parts[0]);
            long max = Long.parseLong(parts[1]);
            if (min > max || Math.abs(min) > RANDOM_LIMIT || Math.abs(max) > RANDOM_LIMIT) {
                return null;
            }
            long value = min + (long) Math.floor(ThreadLocalRandom.current().nextDouble() * (max - min + 1));
            return String.valueOf(value);
        }
        if (fn.equals("base64")) {
            if (!argPresent || arg.isEmpty()) {
                return null;
            }
            String value = lookup.apply(arg);
            return value == null ? null : Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8));
        }
        return null;
    }

    private static String formatNow(Instant instant, String pattern) {
        ZonedDateTime utc = instant.atZone(ZoneOffset.UTC);
        if (pattern == null) {
            return String.format("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                    utc.getYear(), utc.getMonthValue(), utc.getDayOfMonth(),
                    utc.getHour(), utc.getMinute(), utc.getSecond(), utc.getNano() / 1_000_000);
        }
        if (pattern.equals("epoch")) {
            return String.valueOf(instant.getEpochSecond());
        }
        if (pattern.equals("epochMs")) {
            return String.valueOf(instant.toEpochMilli());
        }
        Map<String, String> parts = Map.of(
                "yyyy", pad(utc.getYear(), 4), "MM", pad(utc.getMonthValue(), 2), "dd", pad(utc.getDayOfMonth(), 2),
                "HH", pad(utc.getHour(), 2), "mm", pad(utc.getMinute(), 2), "ss", pad(utc.getSecond(), 2),
                "SSS", pad(utc.getNano() / 1_000_000, 3));
        Matcher letters = NOW_PATTERN_LETTERS.matcher(pattern);
        StringBuilder out = new StringBuilder();
        int last = 0;
        while (letters.find()) {
            out.append(pattern, last, letters.start());
            out.append(parts.get(letters.group()));
            last = letters.end();
        }
        out.append(pattern, last, pattern.length());
        return out.toString();
    }

    private static String pad(int value, int width) {
        return String.format("%0" + width + "d", value);
    }
}
