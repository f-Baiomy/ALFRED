package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;
import com.fathy.alfred.backend.links.domain.JsonRewriter;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Masks secrets at the source (D17, D28): what a stream sends never carries the always-masked headers or anything the
 * owner's redaction rules name - unless the owner set the stream to "send unmasked". The same names and the same
 * marker as the owner's own exports (frontend shared/utils/redact.ts, core/team/azure-export.ts ALWAYS_MASKED_HEADERS),
 * applied while the answer streams through. Rules for one call are applied to every call (masking more, never less).
 */
final class SourceMasker implements JsonRewriter.Visitor {

    static final String REDACTED = "***REDACTED***";

    /** frontend core/team/azure-export.ts ALWAYS_MASKED_HEADERS - keep the two lists the same. */
    static final Set<String> ALWAYS = Set.of("authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
            "x-alfred-team-token", "x-alfred-call");

    static final Set<String> HEADER_CONTAINERS = Set.of("headers", "requestHeaders", "responseHeaders");
    static final Set<String> BODY_FIELDS = Set.of("body", "requestBody", "responseBody");
    static final Set<String> URL_FIELDS = Set.of("url", "uri", "fullUrl");
    static final Set<String> ROW_CONTAINERS = Set.of("rows", "row", "before", "after", "valueBefore", "beforeImage");
    static final Set<String> PARAM_CONTAINERS = Set.of("params", "parameters", "binds");
    /** Where captured rows travel as positional arrays ({@code [[{type, value}, ...]]}) beside their {@code columns}. */
    static final Set<String> POSITIONAL_ROWS = Set.of("rows", "row", "before", "after", "valueBefore", "beforeImage", "beforeImageRows");

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final DefaultPrettyPrinter PRETTY = new DefaultPrettyPrinter().withObjectIndenter(new DefaultIndenter("  ", "\n"));

    private final Set<String> headers = new TreeSet<>();
    private final Set<String> bodyKeys = new TreeSet<>();
    private final Set<String> urlParams = new TreeSet<>();
    private final Set<String> dbColumns = new TreeSet<>();

    /**
     * One entry per open object: the column names it holds ({@code columns: [{name}, ...]} or {@code columns: ["a", ...]}),
     * null while it holds none. A result's columns may sit in its {@code outcome}; they are handed to the object around it.
     */
    private final Deque<List<String>> columnsOf = new ArrayDeque<>();
    /** The position of the cell being read in a positional row. */
    private int cell = -1;

    SourceMasker(List<Redaction> redactions) {
        headers.addAll(ALWAYS);
        for (Redaction r : redactions) {
            String n = r.name() == null ? "" : r.name().toLowerCase(Locale.ROOT).trim();
            if (n.isEmpty()) {
                continue;
            }
            RedactionKind k = r.kind();
            if (k == RedactionKind.REQUEST_HEADER || k == RedactionKind.RESPONSE_HEADER) {
                headers.add(n);
            } else if (k == RedactionKind.REQUEST_BODY_KEY || k == RedactionKind.RESPONSE_BODY_KEY) {
                bodyKeys.add(n);
            } else if (k == RedactionKind.URL_PARAM) {
                urlParams.add(n);
            } else if (k == RedactionKind.DB_COLUMN) {
                dbColumns.add(n);
            }
        }
    }

    private static String[] lastTwo(Deque<String> path) {
        String field = null;
        String parent = null;
        Iterator<String> it = path.descendingIterator();
        while (it.hasNext()) {
            String f = it.next();
            if ("[]".equals(f)) {
                continue;
            }
            if (field == null) {
                field = f;
            } else {
                parent = f;
                break;
            }
        }
        return new String[]{field, parent};
    }

    private static boolean under(Deque<String> path, Set<String> containers) {
        for (String p : path) {
            if (containers.contains(p)) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------------------------------------ positional rows

    @Override
    public void startObject(Deque<String> path) {
        columnsOf.push(NO_COLUMNS);
    }

    @Override
    public void endObject(Deque<String> path) {
        List<String> own = columnsOf.pop();
        if (own != NO_COLUMNS && "outcome".equals(path.peekLast()) && !columnsOf.isEmpty() && columnsOf.peek() == NO_COLUMNS) {
            columnsOf.pop();
            columnsOf.push(own);
        }
    }

    private static final List<String> NO_COLUMNS = List.of();

    @Override
    public void element(Deque<String> path, int index) {
        if (rowContainer(path, 2) != null) {
            cell = index;
        }
    }

    /** The positional-row container {@code back} levels above the end of {@code path} when every level between is "[]". */
    private static String rowContainer(Deque<String> path, int back) {
        Iterator<String> it = path.descendingIterator();
        for (int i = 0; i < back; i++) {
            if (!it.hasNext() || !"[]".equals(it.next())) {
                return null;
            }
        }
        String c = it.hasNext() ? it.next() : null;
        return c != null && POSITIONAL_ROWS.contains(c) ? c : null;
    }

    /** A column name: {@code columns[i].name} of the object holding {@code columns}, or a plain {@code columns[i]}. */
    private void column(Deque<String> path, String value) {
        Iterator<String> it = path.descendingIterator();
        String last = it.hasNext() ? it.next() : null;
        String second = it.hasNext() ? it.next() : null;
        String third = it.hasNext() ? it.next() : null;
        if ("name".equals(last) && "[]".equals(second) && "columns".equals(third) && columnsOf.size() >= 2) {
            // the top is the column object itself; its holder is next
            List<String> top = columnsOf.pop();
            addColumn(value);
            columnsOf.push(top);
        } else if ("[]".equals(last) && "columns".equals(second)) {
            addColumn(value);
        }
    }

    private void addColumn(String name) {
        List<String> own = columnsOf.pop();
        List<String> next = new java.util.ArrayList<>(own);
        next.add(name == null ? "" : name.toLowerCase(Locale.ROOT));
        columnsOf.push(next);
    }

    /** True for a cell of a positional row whose column is masked - or whose column is not known (more, never less). */
    private boolean maskedCell(Deque<String> path) {
        if (dbColumns.isEmpty()) {
            return false;
        }
        String container = "value".equals(path.peekLast()) ? rowContainer(withoutLast(path), 2) : null;
        if (container == null) {
            container = rowContainer(path, 2);
        }
        if (container == null) {
            return false;
        }
        if (!"rows".equals(container) && !"row".equals(container)) {
            return true; // a before-image's columns are the table's, not the result's: every cell, never a guess
        }
        List<String> cols = null;
        for (List<String> c : columnsOf) {
            if (c != NO_COLUMNS) {
                cols = c;
                break;
            }
        }
        return cols == null || cell < 0 || cell >= cols.size() || dbColumns.contains(cols.get(cell));
    }

    private static Deque<String> withoutLast(Deque<String> path) {
        Deque<String> copy = new ArrayDeque<>(path);
        copy.pollLast();
        return copy;
    }

    @Override
    public String string(Deque<String> path, String value) {
        column(path, value);
        if (maskedCell(path)) {
            return REDACTED;
        }
        String[] fp = lastTwo(path);
        String field = fp[0];
        String parent = fp[1];
        if (field == null) {
            return value;
        }
        if (parent != null && HEADER_CONTAINERS.contains(parent) && headers.contains(field.toLowerCase(Locale.ROOT))) {
            return REDACTED;
        }
        if (BODY_FIELDS.contains(field) && !bodyKeys.isEmpty()) {
            return body(value);
        }
        if (URL_FIELDS.contains(field) && !urlParams.isEmpty()) {
            return url(value);
        }
        if (!dbColumns.isEmpty() && dbColumns.contains(field.toLowerCase(Locale.ROOT)) && under(path, ROW_CONTAINERS)) {
            return REDACTED;
        }
        if (!dbColumns.isEmpty() && under(path, PARAM_CONTAINERS) && under(path, Set.of("statements", "statement"))) {
            return REDACTED;
        }
        return value;
    }

    @Override
    public String scalar(Deque<String> path) {
        if (dbColumns.isEmpty()) {
            return null;
        }
        if (maskedCell(path)) {
            return REDACTED;
        }
        String field = lastTwo(path)[0];
        if (field != null && dbColumns.contains(field.toLowerCase(Locale.ROOT)) && under(path, ROW_CONTAINERS)) {
            return REDACTED;
        }
        return null;
    }

    // ------------------------------------------------------------------------------------------------------- bodies

    String body(String body) {
        if (body == null || body.isBlank()) {
            return body;
        }
        String t = body.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
            try {
                JsonNode root = JSON.readTree(body);
                int[] n = {0};
                JsonNode masked = mask(root, n);
                return n[0] == 0 ? body : JSON.writer(PRETTY).writeValueAsString(masked);
            } catch (Exception e) {
                return body;
            }
        }
        if (t.startsWith("<")) {
            return xml(body);
        }
        if (FORM.matcher(t).matches()) {
            String masked = pairs("?" + t, bodyKeys);
            return masked.equals("?" + t) ? body : masked.substring(1);
        }
        return body;
    }

    private JsonNode mask(JsonNode node, int[] n) {
        if (node.isArray()) {
            ArrayNode out = JSON.createArrayNode();
            node.forEach(x -> out.add(mask(x, n)));
            return out;
        }
        if (node.isObject()) {
            ObjectNode out = JSON.createObjectNode();
            for (Iterator<Map.Entry<String, JsonNode>> it = node.fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                if (bodyKeys.contains(e.getKey().toLowerCase(Locale.ROOT))) {
                    out.set(e.getKey(), TextNode.valueOf(REDACTED));
                    n[0]++;
                } else {
                    out.set(e.getKey(), mask(e.getValue(), n));
                }
            }
            return out;
        }
        return node;
    }

    private static final Pattern FORM = Pattern.compile("^[^\\s=&]+=[^\\s&]*(?:&[^\\s=&]+=[^\\s&]*)*$");
    private static final String XML_NAME = "[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?";
    private static final Pattern XML_ELEMENT = Pattern.compile("<(" + XML_NAME + ")(\\s[^>]*)?>([^<]*)</\\1\\s*>");
    private static final Pattern XML_ATTRIBUTE = Pattern.compile("(\\s)(" + XML_NAME + ")(\\s*=\\s*)([\"'])([^\"']*)\\4");

    private boolean xmlName(String qualified) {
        String lower = qualified.toLowerCase(Locale.ROOT);
        return bodyKeys.contains(lower) || bodyKeys.contains(lower.substring(lower.indexOf(':') + 1));
    }

    private String xml(String body) {
        Matcher m = XML_ELEMENT.matcher(body);
        StringBuilder a = new StringBuilder();
        while (m.find()) {
            String name = m.group(1);
            String attrs = m.group(2) == null ? "" : m.group(2);
            String text = m.group(3);
            m.appendReplacement(a, Matcher.quoteReplacement(xmlName(name) && !text.isEmpty() ? "<" + name + attrs + ">" + REDACTED + "</" + name + ">"
                    : m.group()));
        }
        m.appendTail(a);
        Matcher at = XML_ATTRIBUTE.matcher(a.toString());
        StringBuilder b = new StringBuilder();
        while (at.find()) {
            at.appendReplacement(b, Matcher.quoteReplacement(xmlName(at.group(2))
                    ? at.group(1) + at.group(2) + at.group(3) + at.group(4) + REDACTED + at.group(4) : at.group()));
        }
        at.appendTail(b);
        return b.toString();
    }

    /** Each query pair whose name is masked, without re-encoding the rest. */
    String url(String url) {
        return pairs(url, urlParams);
    }

    /** Each {@code name=value} pair after the {@code ?} whose name is one of {@code names}, the rest byte for byte. */
    private static String pairs(String url, Set<String> names) {
        if (url == null) {
            return null;
        }
        int q = url.indexOf('?');
        if (q < 0) {
            return url;
        }
        int hash = url.indexOf('#', q);
        String query = hash < 0 ? url.substring(q + 1) : url.substring(q + 1, hash);
        StringBuilder out = new StringBuilder(url.substring(0, q + 1));
        String[] pairs = query.split("&", -1);
        for (int i = 0; i < pairs.length; i++) {
            if (i > 0) {
                out.append('&');
            }
            String pair = pairs[i];
            int eq = pair.indexOf('=');
            String name = eq < 0 ? pair : pair.substring(0, eq);
            String decoded;
            try {
                decoded = java.net.URLDecoder.decode(name, java.nio.charset.StandardCharsets.UTF_8);
            } catch (IllegalArgumentException e) {
                decoded = name;
            }
            if (eq >= 0 && names.contains(decoded.toLowerCase(Locale.ROOT))) {
                out.append(name).append('=').append(REDACTED);
            } else {
                out.append(pair);
            }
        }
        if (hash >= 0) {
            out.append(url.substring(hash));
        }
        return out.toString();
    }
}
