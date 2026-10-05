package com.fathy.alfred.backend.triage.domain;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Java twin of the frontend's {@code shared/utils/soft-failure.ts} - an error inside a body whose status claims
 * success (a SOAP Fault, an OTA {@code <Error Code="322">}, a JSON {@code errors} list, {@code "success": false}) and
 * a successful JSON response whose result lists are all empty. The backend runs it once, when a call completes, so the
 * mark is saved with the call; the MCP server and the UI read the saved mark instead of every body.
 *
 * <p>It must answer exactly what the TypeScript answers, so it copies JavaScript where Java differs: object keys in
 * JavaScript's order (integer-like keys first, ascending), {@code JSON.stringify}'s text, JavaScript's number-to-text,
 * whitespace and trimming. Both test suites run the same vectors
 * ({@code specs/007-alfred-mcp-server/soft-failure-vectors.json}), so the two cannot drift apart silently.
 */
public final class SoftFailures {

    private static final int MESSAGE_LIMIT = 200;

    /** JavaScript's {@code \s} (and what {@code trim()} removes). */
    private static final String WS = "[\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
    private static final Pattern WS_RUN = Pattern.compile(WS + "+");
    private static final Pattern LEADING_WS = Pattern.compile("^" + WS + "+");
    private static final Pattern TAG = Pattern.compile("<[^>]+>");

    private static final Pattern FAULT = Pattern.compile("<(?:[\\w.-]+:)?Fault\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?Fault>", Pattern.CASE_INSENSITIVE);
    private static final Pattern FAULT_TEXT = Pattern.compile("<(?:[\\w.-]+:)?(?:faultstring|Text|Reason)\\b[^>]*>([\\s\\S]*?)</", Pattern.CASE_INSENSITIVE);
    private static final Pattern FAULT_CODE = Pattern.compile("<(?:[\\w.-]+:)?(?:faultcode|Value)\\b[^>]*>([^<]*)<", Pattern.CASE_INSENSITIVE);
    private static final Pattern ERROR = Pattern.compile("<(?:[\\w.-]+:)?Error\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?Error>)", Pattern.CASE_INSENSITIVE);

    private static final Pattern RESULT_KEY = Pattern.compile(
            "(?:offers?|results?|items|flights|journeys|itineraries|records|hits|rows|hotels|fares|availability|options|list)\\z", Pattern.CASE_INSENSITIVE);
    private static final Pattern COUNT_KEY = Pattern.compile("total|count|totalCount|totalResults|resultCount|numberOfResults", Pattern.CASE_INSENSITIVE);

    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    static {
        // A response body is whatever the supplier sent; JSON.parse has no string-length limit, Jackson's default has.
        JSON.getFactory().setStreamReadConstraints(StreamReadConstraints.builder()
                .maxStringLength(Integer.MAX_VALUE).maxNumberLength(Integer.MAX_VALUE).maxNestingDepth(5_000).build());
    }

    private SoftFailures() {
    }

    // ------------------------------------------------------------------ soft failure

    /** The soft failure in a response body, or null - only for a response whose status claims success (under 400). */
    public static SoftFailure softFailureOf(Integer status, String error, String body) {
        if (truthy(error) || status == null || status >= 400 || body == null || body.isEmpty()) {
            return null;
        }
        String trimmed = trimStart(body);
        if (trimmed.startsWith("<")) {
            return xmlFailure(trimmed);
        }
        if (trimmed.startsWith("{")) {
            JsonNode parsed = parse(trimmed);
            return parsed == null ? null : jsonFailure(parsed, 0);
        }
        return null;
    }

    private static SoftFailure xmlFailure(String body) {
        Matcher fault = FAULT.matcher(body);
        if (fault.find()) {
            String inner = fault.group(1);
            Matcher text = FAULT_TEXT.matcher(inner);
            Matcher code = FAULT_CODE.matcher(inner);
            String message = text.find() ? TAG.matcher(text.group(1)).replaceAll(" ") : "SOAP Fault";
            return new SoftFailure("soap-fault", code.find() ? jsTrim(decodeXml(code.group(1))) : null, shorten(decodeXml(message)));
        }
        // OTA and most travel XML: <Errors><Error Code="322" ShortText="...">text</Error></Errors>. A <Warning> is not
        // a failure; an <Error> element anywhere is.
        Matcher error = ERROR.matcher(body);
        if (error.find()) {
            String attrs = error.group(1) == null ? "" : error.group(1);
            String text = TAG.matcher(error.group(2) == null ? "" : error.group(2)).replaceAll(" ");
            String message = attr(attrs, "ShortText");
            if (message == null) {
                message = jsTrim(text).isEmpty() ? null : decodeXml(text);
            }
            if (message == null) {
                message = attr(attrs, "Type");
            }
            if (message == null) {
                message = "Error element in the response";
            }
            return new SoftFailure("xml-error", attr(attrs, "Code"), shorten(message));
        }
        return null;
    }

    private static String attr(String attrs, String name) {
        Matcher m = Pattern.compile("\\b" + name + WS + "*=" + WS + "*[\"']([^\"']*)[\"']", Pattern.CASE_INSENSITIVE).matcher(attrs);
        return m.find() ? decodeXml(m.group(1)) : null;
    }

    private static String decodeXml(String text) {
        return text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    }

    /** Checks the top level and one level down - deeper keys named "error" are too often ordinary data. */
    private static SoftFailure jsonFailure(JsonNode value, int depth) {
        if (!value.isObject()) {
            return null;
        }
        for (String key : List.of("errors", "Errors")) {
            JsonNode errors = value.get(key);
            if (errors != null && errors.isArray() && !errors.isEmpty()) {
                return new SoftFailure("json-errors", codeOf(errors.get(0)), shorten(messageOf(errors.get(0))));
            }
            if (errors != null && errors.isObject() && !errors.isEmpty()) {
                JsonNode first = errors.get(jsKeys(errors).get(0));
                return new SoftFailure("json-errors", codeOf(first), shorten(messageOf(first)));
            }
        }
        if (isFalse(value.get("success")) || isFalse(value.get("Success")) || isFalse(value.get("ok"))) {
            JsonNode message = firstPresent(value, "message", "error", "errorMessage");
            return new SoftFailure("json-success-false", codeOf(value), shorten(message == null ? "success: false" : messageOf(message)));
        }
        for (String key : List.of("error", "Error")) {
            JsonNode error = value.get(key);
            if (error != null && !error.isNull() && !isFalse(error) && !(error.isTextual() && error.asText().isEmpty())
                    && !(error.isContainerNode() && error.isEmpty())) {
                return new SoftFailure("json-error", codeOf(error), shorten(messageOf(error)));
            }
        }
        if (depth == 0) {
            for (String key : jsKeys(value)) {
                SoftFailure found = jsonFailure(value.get(key), 1);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /** {@code a ?? b ?? c}: the first key present with a value other than null. */
    private static JsonNode firstPresent(JsonNode object, String... keys) {
        for (String key : keys) {
            JsonNode v = object.get(key);
            if (v != null && !v.isNull()) {
                return v;
            }
        }
        return null;
    }

    private static boolean isFalse(JsonNode node) {
        return node != null && node.isBoolean() && !node.booleanValue();
    }

    private static String messageOf(JsonNode value) {
        if (value.isTextual()) {
            return value.asText();
        }
        if (value.isContainerNode()) {
            if (value.isObject()) {
                for (String key : List.of("message", "Message", "description", "detail", "error", "errorMessage", "title", "text")) {
                    JsonNode v = value.get(key);
                    if (v != null && v.isTextual() && !v.asText().isEmpty()) {
                        return v.asText();
                    }
                }
            }
            return stringify(value);
        }
        return jsString(value);
    }

    private static String codeOf(JsonNode value) {
        if (value == null || !value.isObject()) {
            return null;
        }
        for (String key : List.of("code", "Code", "errorCode", "status")) {
            JsonNode v = value.get(key);
            if (v != null && (v.isTextual() || v.isNumber())) {
                return v.isTextual() ? v.asText() : jsNumber(v.doubleValue());
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ empty result

    /**
     * A successful JSON response whose result lists are all empty ({@code "offers": {}}, {@code []}, {@code "total": 0})
     * - "the search found nothing". The empty keys as paths ("searchOffers.offers"), or null when any result-like key
     * holds something, or the body has none at all.
     */
    public static List<String> emptyResultOf(Integer status, String error, String body) {
        if (truthy(error) || status == null || status >= 300 || body == null) {
            return null;
        }
        String trimmed = trimStart(body);
        if (!trimmed.startsWith("{")) {
            return null;
        }
        JsonNode parsed = parse(trimmed);
        if (parsed == null) {
            return null;
        }
        List<String> empty = new ArrayList<>();
        boolean[] filled = {false};
        visit(parsed, "", 0, empty, filled);
        return !filled[0] && !empty.isEmpty() ? empty : null;
    }

    private static void visit(JsonNode node, String path, int depth, List<String> empty, boolean[] filled) {
        if (!node.isObject() || depth > 2) {
            return;
        }
        for (String key : jsKeys(node)) {
            JsonNode value = node.get(key);
            String at = path.isEmpty() ? key : path + "." + key;
            // searchOffers: { offers: {}, journeys: {} } is a wrapper, not a list: judged by what it holds.
            boolean wrapper = value.isObject() && jsKeys(value).stream().anyMatch(k -> RESULT_KEY.matcher(k).find() || COUNT_KEY.matcher(k).matches());
            if (RESULT_KEY.matcher(key).find() && value.isContainerNode() && !wrapper) {
                // bestPriceOffers: { "00:00-05:59": {}, ... } holds buckets, not results: only what is in them counts.
                long size = value.isArray() ? value.size() : countFilled(value);
                if (size == 0) {
                    empty.add(at);
                } else {
                    filled[0] = true;
                }
            } else if (COUNT_KEY.matcher(key).matches() && value.isNumber()) {
                if (value.doubleValue() == 0) {
                    empty.add(at);
                } else {
                    filled[0] = true;
                }
            }
            if (value.isObject()) {
                visit(value, at, depth + 1, empty, filled);
            }
        }
    }

    private static long countFilled(JsonNode object) {
        long n = 0;
        for (Iterator<JsonNode> it = object.elements(); it.hasNext(); ) {
            JsonNode v = it.next();
            boolean emptyHolder = v.isNull() || (v.isContainerNode() && v.isEmpty());
            if (!emptyHolder) {
                n++;
            }
        }
        return n;
    }

    // ------------------------------------------------------------------ JavaScript semantics

    private static boolean truthy(String text) {
        return text != null && !text.isEmpty();
    }

    private static JsonNode parse(String text) {
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException | RuntimeException e) {
            return null;
        }
    }

    private static String trimStart(String text) {
        return LEADING_WS.matcher(text).replaceFirst("");
    }

    private static String jsTrim(String text) {
        return Pattern.compile(WS + "+\\z").matcher(trimStart(text)).replaceFirst("");
    }

    private static String shorten(String text) {
        String clean = jsTrim(WS_RUN.matcher(text).replaceAll(" "));
        return clean.length() > MESSAGE_LIMIT ? clean.substring(0, MESSAGE_LIMIT) + "…" : clean;
    }

    /** {@code Object.keys} order: integer-like keys (array indexes) first in ascending order, then the rest as written. */
    static List<String> jsKeys(JsonNode object) {
        TreeMap<Long, String> indexes = new TreeMap<>();
        List<String> rest = new ArrayList<>();
        for (Iterator<Map.Entry<String, JsonNode>> it = object.fields(); it.hasNext(); ) {
            String key = it.next().getKey();
            Long index = arrayIndex(key);
            if (index != null) {
                indexes.put(index, key);
            } else {
                rest.add(key);
            }
        }
        List<String> keys = new ArrayList<>(indexes.values());
        keys.addAll(rest);
        return keys;
    }

    private static Long arrayIndex(String key) {
        if (key.isEmpty() || key.length() > 10 || (key.length() > 1 && key.charAt(0) == '0')) {
            return null;
        }
        for (int i = 0; i < key.length(); i++) {
            if (key.charAt(i) < '0' || key.charAt(i) > '9') {
                return null;
            }
        }
        long value = Long.parseLong(key);
        return value <= 4_294_967_294L ? value : null;
    }

    /** {@code String(value)} for a primitive. */
    private static String jsString(JsonNode value) {
        if (value.isNumber()) {
            double d = value.doubleValue();
            return Double.isInfinite(d) ? (d > 0 ? "Infinity" : "-Infinity") : jsNumber(d);
        }
        if (value.isBoolean()) {
            return String.valueOf(value.booleanValue());
        }
        return value.isNull() ? "null" : value.asText();
    }

    /** {@code JSON.stringify(value)}. */
    static String stringify(JsonNode value) {
        StringBuilder out = new StringBuilder();
        stringify(value, out);
        return out.toString();
    }

    private static void stringify(JsonNode value, StringBuilder out) {
        if (value.isObject()) {
            out.append('{');
            boolean first = true;
            for (String key : jsKeys(value)) {
                if (!first) {
                    out.append(',');
                }
                first = false;
                quote(key, out);
                out.append(':');
                stringify(value.get(key), out);
            }
            out.append('}');
        } else if (value.isArray()) {
            out.append('[');
            for (int i = 0; i < value.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                stringify(value.get(i), out);
            }
            out.append(']');
        } else if (value.isTextual()) {
            quote(value.asText(), out);
        } else if (value.isNumber()) {
            double d = value.doubleValue();
            out.append(Double.isInfinite(d) ? "null" : jsNumber(d));
        } else if (value.isBoolean()) {
            out.append(value.booleanValue());
        } else {
            out.append("null");
        }
    }

    private static void quote(String text, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    boolean loneSurrogate = Character.isHighSurrogate(c) ? !(i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1)))
                            : Character.isLowSurrogate(c) && !(i > 0 && Character.isHighSurrogate(text.charAt(i - 1)));
                    if (c < 0x20 || loneSurrogate) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    /** ECMAScript Number::toString for a finite double (Java 19+ Double.toString gives the same shortest digits). */
    static String jsNumber(double value) {
        if (value == 0) {
            return "0";
        }
        if (value < 0) {
            return "-" + jsNumber(-value);
        }
        BigDecimal exact = new BigDecimal(Double.toString(value)).stripTrailingZeros();
        String digits = exact.unscaledValue().toString();
        int k = digits.length();
        int n = k - exact.scale();
        if (k <= n && n <= 21) {
            return digits + "0".repeat(n - k);
        }
        if (0 < n && n <= 21) {
            return digits.substring(0, n) + "." + digits.substring(n);
        }
        if (-6 < n && n <= 0) {
            return "0." + "0".repeat(-n) + digits;
        }
        int e = n - 1;
        String exponent = "e" + (e < 0 ? "-" : "+") + Math.abs(e);
        return k == 1 ? digits + exponent : digits.charAt(0) + "." + digits.substring(1) + exponent;
    }
}
