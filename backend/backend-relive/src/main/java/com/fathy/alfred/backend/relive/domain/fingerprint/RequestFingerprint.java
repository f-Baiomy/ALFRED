package com.fathy.alfred.backend.relive.domain.fingerprint;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.StringReader;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SEMANTIC_V1 request fingerprint. The byte layout matches {@code semantic_fingerprint_v1} in
 * {@code proxy/relive.py}, which hashes the live request with the same canonical form
 * ({@code interception.canonical_endpoint}, {@code stable_header_items}, {@code canonical_body}).
 * A stored step is hashed once, here, when the cycle is saved. A replay run does not hash it again.
 */
public final class RequestFingerprint {

    public static final String VERSION = "SEMANTIC_V1";

    private static final int BODY_LIMIT = 2_000_000;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern JSON_KEPT = Pattern.compile(
            "\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*(?:\"|\\\\?\\z)|[^\\s\"]+", Pattern.DOTALL);
    private static final Pattern BETWEEN_TAGS = Pattern.compile(">\\s+<");
    private static final Pattern FIRST_CHAR = Pattern.compile("\\s*(\\S)");
    private static final Pattern TRACE = Pattern.compile("trace|correlation|request-?id|span-?id", Pattern.CASE_INSENSITIVE);
    private static final Set<String> GENERATED = Set.of(
            "host", "content-length", "transfer-encoding", "connection", "keep-alive",
            "proxy-connection", "upgrade", "te", "trailer", "date", "accept-encoding",
            "user-agent", "cookie", "via", "forwarded",
            "x-request-id", "x-correlation-id", "x-trace-id", "x-operation-id",
            "x-alfred-relive", "request-id", "request-context",
            "traceparent", "tracestate", "x-amzn-trace-id", "x-cloud-trace-context",
            "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-port");

    private RequestFingerprint() {
    }

    public static String of(FrozenCall recording) {
        if (recording == null) {
            return null;
        }
        return of(recording.method(), recording.url(), recording.requestHeaders(), recording.requestBody());
    }

    public static String of(String method, String url, Map<String, String> headers, String body) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(utf8(VERSION));
            digest.update((byte) 0);
            for (String item : endpoint(method, url)) {
                digest.update(utf8(item));
                digest.update((byte) 0);
            }
            digest.update((byte) 0);
            for (String[] header : stableHeaders(headers)) {
                digest.update(utf8(header[0]));
                digest.update((byte) 0);
                digest.update(utf8(header[1]));
                digest.update((byte) 0);
            }
            digest.update((byte) 0);
            digest.update(utf8(canonicalBody(body)));
            return HexFormat.of().formatHex(digest.digest());
        } catch (Exception ex) {
            throw new IllegalStateException("Could not fingerprint a recorded request", ex);
        }
    }

    /** (method, scheme, host, path, query), the same five fields as {@code canonical_endpoint}. */
    static String[] endpoint(String method, String url) {
        String scheme = "";
        String host = "";
        String path = url == null ? "" : url;
        String query = "";
        if (url != null && !url.isBlank()) {
            try {
                URI uri = URI.create(url);
                if (uri.getScheme() != null) {
                    scheme = uri.getScheme();
                }
                if (uri.getHost() != null) {
                    host = uri.getHost();
                }
                if (uri.getRawPath() != null) {
                    path = uri.getRawPath();
                }
                if (uri.getRawQuery() != null) {
                    query = uri.getRawQuery();
                }
            } catch (IllegalArgumentException ignored) {
                // The raw URL is the path. The hash stays stable for this recording.
            }
        }
        return new String[]{
                method == null ? "" : method.toUpperCase(Locale.ROOT),
                scheme.toLowerCase(Locale.ROOT),
                hostOnly(host),
                pathOnly(path),
                canonicalQuery(query)
        };
    }

    public static List<String[]> stableHeaders(Map<String, String> headers) {
        List<String[]> items = new ArrayList<>();
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                String name = entry.getKey() == null ? "" : entry.getKey().toLowerCase(Locale.ROOT);
                if (generated(name)) {
                    continue;
                }
                String value = entry.getValue() == null ? "" : entry.getValue().strip();
                items.add(new String[]{name, value});
            }
        }
        items.sort(Comparator.comparing((String[] item) -> item[0]).thenComparing(item -> item[1]));
        return items;
    }

    static String canonicalBody(String text) {
        text = text == null ? "" : text;
        if (text.length() > BODY_LIMIT) {
            return oversized(text);
        }
        String kind = bodyKind(text);
        if ("json".equals(kind)) {
            try {
                return canonicalJson(JSON.readTree(text));
            } catch (Exception ex) {
                return squashJson(text);
            }
        }
        if ("xml".equals(kind)) {
            return canonicalXml(text);
        }
        return text.replace("\r\n", "\n").replace("\r", "\n");
    }

    private static String oversized(String text) {
        String kind = bodyKind(text);
        if ("json".equals(kind)) {
            return squashJson(text);
        }
        if ("xml".equals(kind)) {
            return squashXml(text).replace("\r\n", "\n").replace("\r", "\n");
        }
        return text.replace("\r\n", "\n").replace("\r", "\n");
    }

    private static boolean generated(String folded) {
        return GENERATED.contains(folded)
                || folded.startsWith("x-b3-")
                || folded.startsWith("x-alfred-")
                || TRACE.matcher(folded).find();
    }

    private static String hostOnly(String host) {
        host = host == null ? "" : host.toLowerCase(Locale.ROOT);
        while (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        if (host.startsWith("[") && host.contains("]")) {
            return host;
        }
        int colon = host.indexOf(':');
        return colon < 0 ? host : host.substring(0, colon);
    }

    private static String pathOnly(String path) {
        if (path == null || path.isEmpty()) {
            path = "/";
        }
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        if (path.isEmpty()) {
            path = "/";
        }
        return path.startsWith("/") ? path : "/" + path;
    }

    private static String canonicalQuery(String query) {
        if (query == null || query.isEmpty()) {
            return "";
        }
        List<String[]> items = new ArrayList<>();
        for (String pair : query.split("&", -1)) {
            if (pair.isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String rawName = eq < 0 ? pair : pair.substring(0, eq);
            String rawValue = eq < 0 ? "" : pair.substring(eq + 1);
            // The live proxy hashes mitmproxy's decoded query dict (percent-decoding, '+' as space).
            items.add(new String[]{decodeQueryComponent(rawName), decodeQueryComponent(rawValue)});
        }
        items.sort(Comparator.comparing((String[] item) -> item[0]).thenComparing(item -> item[1]));
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) {
                out.append('&');
            }
            out.append(items.get(i)[0]).append('=').append(items.get(i)[1]);
        }
        return out.toString();
    }

    /** Same decoding as urllib.parse.unquote_plus, which mitmproxy applies to each query pair. */
    private static String decodeQueryComponent(String raw) {
        if (raw == null || raw.isEmpty()) {
            return "";
        }
        try {
            return URLDecoder.decode(raw, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            return raw;
        }
    }

    private static String bodyKind(String text) {
        Matcher found = FIRST_CHAR.matcher(text == null ? "" : text);
        if (!found.find()) {
            return null;
        }
        String head = found.group(1);
        if ("{".equals(head) || "[".equals(head)) {
            return "json";
        }
        if ("<".equals(head)) {
            return "xml";
        }
        return null;
    }

    private static String squashJson(String text) {
        Matcher matcher = JSON_KEPT.matcher(text);
        StringBuilder out = new StringBuilder();
        while (matcher.find()) {
            out.append(matcher.group());
        }
        return out.toString();
    }

    private static String squashXml(String text) {
        return BETWEEN_TAGS.matcher(text.strip()).replaceAll("><");
    }

    static String canonicalJson(JsonNode node) {
        StringBuilder out = new StringBuilder();
        writeJson(node, out);
        return out.toString();
    }

    private static void writeJson(JsonNode node, StringBuilder out) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            out.append("null");
            return;
        }
        if (node.isObject()) {
            List<String> names = new ArrayList<>();
            node.fieldNames().forEachRemaining(names::add);
            names.sort(String::compareTo);
            out.append('{');
            for (int i = 0; i < names.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                quote(names.get(i), out);
                out.append(':');
                writeJson(node.get(names.get(i)), out);
            }
            out.append('}');
            return;
        }
        if (node.isArray()) {
            out.append('[');
            for (int i = 0; i < node.size(); i++) {
                if (i > 0) {
                    out.append(',');
                }
                writeJson(node.get(i), out);
            }
            out.append(']');
            return;
        }
        if (node.isTextual()) {
            quote(node.textValue(), out);
            return;
        }
        if (node.isIntegralNumber()) {
            out.append(node.bigIntegerValue().toString());
            return;
        }
        if (node.isFloatingPointNumber()) {
            out.append(pythonFloat(node.doubleValue()));
            return;
        }
        if (node.isBoolean()) {
            out.append(node.booleanValue() ? "true" : "false");
            return;
        }
        quote(node.asText(), out);
    }

    /**
     * Python {@code json.dumps} float text: decimal when the exponent is between -4 and 15,
     * otherwise {@code d.ddde+dd} with a sign and at least two exponent digits.
     */
    private static String pythonFloat(double value) {
        if (Double.isNaN(value)) {
            return "NaN";
        }
        if (value == Double.POSITIVE_INFINITY) {
            return "Infinity";
        }
        if (value == Double.NEGATIVE_INFINITY) {
            return "-Infinity";
        }
        if (value == 0.0d) {
            return Double.doubleToRawLongBits(value) < 0 ? "-0.0" : "0.0";
        }
        boolean negative = value < 0;
        String raw = Double.toString(Math.abs(value));
        int marker = raw.indexOf('E');
        String body = marker < 0 ? raw : pythonScientific(raw.substring(0, marker), Integer.parseInt(raw.substring(marker + 1)));
        return negative ? "-" + body : body;
    }

    private static String pythonScientific(String mantissa, int exp) {
        String digits = mantissa.replace(".", "");
        int end = digits.length();
        while (end > 1 && digits.charAt(end - 1) == '0') {
            end--;
        }
        digits = digits.substring(0, end);
        if (exp >= -4 && exp < 16) {
            return decimalFromScientific(digits, exp);
        }
        String exponent = "e" + (exp >= 0 ? "+" : "-") + String.format(Locale.US, "%02d", Math.abs(exp));
        if (digits.length() == 1) {
            return digits.charAt(0) + exponent;
        }
        return digits.charAt(0) + "." + digits.substring(1) + exponent;
    }

    private static String decimalFromScientific(String digits, int exp) {
        if (exp >= 0) {
            StringBuilder whole = new StringBuilder();
            whole.append(digits.charAt(0));
            int fractionAt;
            if (exp < digits.length() - 1) {
                whole.append(digits, 1, 1 + exp);
                fractionAt = 1 + exp;
            } else {
                whole.append(digits.substring(1));
                whole.append("0".repeat(exp - (digits.length() - 1)));
                fractionAt = digits.length();
            }
            if (fractionAt >= digits.length()) {
                return whole + ".0";
            }
            return whole + "." + digits.substring(fractionAt);
        }
        return "0." + "0".repeat(-exp - 1) + digits;
    }

    private static void quote(String value, StringBuilder out) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static String canonicalXml(String text) {
        String head = text.length() > 800 ? text.substring(0, 800) : text;
        if (head.toUpperCase(Locale.ROOT).contains("<!DOCTYPE")) {
            return squashXml(text).replace("\r\n", "\n").replace("\r", "\n");
        }
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setExpandEntityReferences(false);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            Document document = factory.newDocumentBuilder().parse(new InputSource(new StringReader(text)));
            Element root = document.getDocumentElement();
            return root == null ? squashXml(text).replace("\r\n", "\n").replace("\r", "\n") : render(root);
        } catch (Exception ex) {
            return squashXml(text).replace("\r\n", "\n").replace("\r", "\n");
        }
    }

    private static String render(Element element) {
        StringBuilder out = new StringBuilder();
        String name = clark(element);
        out.append('<').append(name);
        List<String[]> attributes = new ArrayList<>();
        NamedNodeMap attrs = element.getAttributes();
        for (int i = 0; i < attrs.getLength(); i++) {
            Node attr = attrs.item(i);
            if ("http://www.w3.org/2000/xmlns/".equals(attr.getNamespaceURI())
                    || attr.getNodeName().startsWith("xmlns")) {
                continue;
            }
            attributes.add(new String[]{clark(attr), attr.getNodeValue() == null ? "" : attr.getNodeValue()});
        }
        attributes.sort(Comparator.comparing((String[] item) -> item[0]).thenComparing(item -> item[1]));
        for (String[] attribute : attributes) {
            out.append(' ').append(attribute[0]).append("=\"").append(xmlEscape(attribute[1])).append('"');
        }
        out.append('>');
        StringBuilder direct = new StringBuilder();
        boolean seenElement = false;
        StringBuilder children = new StringBuilder();
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element childElement) {
                seenElement = true;
                children.append(render(childElement));
            } else if (!seenElement && (child.getNodeType() == Node.TEXT_NODE || child.getNodeType() == Node.CDATA_SECTION_NODE)) {
                direct.append(child.getNodeValue());
            }
        }
        out.append(direct.toString().strip());
        out.append(children);
        out.append("</").append(name).append('>');
        return out.toString();
    }

    private static String clark(Node node) {
        String local = node.getLocalName() == null ? node.getNodeName() : node.getLocalName();
        String uri = node.getNamespaceURI();
        if (uri == null || uri.isEmpty()) {
            return local;
        }
        return "{" + uri + "}" + local;
    }

    private static String xmlEscape(String value) {
        return value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;");
    }

    private static byte[] utf8(String value) {
        return (value == null ? "" : value).getBytes(StandardCharsets.UTF_8);
    }
}
