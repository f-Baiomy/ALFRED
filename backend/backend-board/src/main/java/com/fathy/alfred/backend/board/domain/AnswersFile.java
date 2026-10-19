package com.fathy.alfred.backend.board.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Reads an answers file (specs/037 D15-D17): the HTML page a questions form downloads, or a .zip holding that one page.
 * Only the {@code <script type="application/json" id="alfred-answers">} block is read, by an HTML parser and a JSON
 * parser - nothing in the file runs, nothing is evaluated, and the page's own text means nothing. A .zip is opened with
 * every size counted as it is read (never the size the archive claims), so an archive that inflates past the limit stops
 * at the limit. The same rules, messages and test files as the MCP server's {@code answers-file.ts}.
 */
public final class AnswersFile {

    public static final int MAX_BYTES = 2 * 1024 * 1024;
    public static final int VERSION = 1;
    public static final String NOT_ANSWERS = "Not an Alfred answers file";
    public static final String TOO_BIG = "An answers file is at most 2 MB";
    public static final String BAD_ZIP = "A .zip is accepted only when it holds one Alfred answers file";

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern FORM_ID = Pattern.compile("^qf_[0-9a-f]{32}$");
    private static final Pattern ID = Pattern.compile("^[a-z][0-9]{1,6}$");
    private static final int MAX_ANSWERS = 500;
    private static final int MAX_NOTE = 16_000;
    private static final int MAX_NAME = 200;
    private static final int MAX_ENTRIES = 20;

    private AnswersFile() {
    }

    public record Follow(String q, List<String> choice) {

        public Follow {
            choice = List.copyOf(choice);
        }
    }

    public record Answer(String q, List<String> choice, boolean other, boolean later, String note, String sure, Follow follow) {

        public Answer {
            choice = List.copyOf(choice);
        }
    }

    public record Parsed(String formId, int version, String board, String lang, String answeredBy, String role, Instant answeredAt,
                         List<Answer> answers) {

        public Parsed {
            answers = List.copyOf(answers);
        }
    }

    /** The answers, or why the file is not read ({@code problem}); exactly one of the two. */
    public record Read(Parsed parsed, String problem) {

        static Read refused(String problem) {
            return new Read(null, problem);
        }

        public boolean ok() {
            return parsed != null;
        }
    }

    /** A file as uploaded: a .zip (by its name or its first bytes) or the html itself. */
    public static Read read(String name, byte[] data) {
        if (data == null || data.length == 0) {
            return Read.refused(NOT_ANSWERS);
        }
        boolean zip = (name != null && name.toLowerCase(Locale.ROOT).endsWith(".zip"))
                || (data.length > 3 && data[0] == 'P' && data[1] == 'K' && data[2] == 3 && data[3] == 4);
        if (zip) {
            if (data.length > MAX_BYTES) {
                return Read.refused(TOO_BIG);
            }
            Unzipped u = unzip(data);
            return u.html == null ? Read.refused(u.problem) : html(u.html);
        }
        if (data.length > MAX_BYTES) {
            return Read.refused(TOO_BIG);
        }
        return html(new String(data, StandardCharsets.UTF_8));
    }

    /** The page's text. */
    public static Read html(String html) {
        if (html == null || html.isBlank()) {
            return Read.refused(NOT_ANSWERS);
        }
        if (html.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            return Read.refused(TOO_BIG);
        }
        Document doc = Jsoup.parse(html);
        Element block = doc.getElementById("alfred-answers");
        if (block == null || !"script".equals(block.tagName()) || !"application/json".equalsIgnoreCase(block.attr("type").strip())) {
            return Read.refused(NOT_ANSWERS);
        }
        JsonNode node;
        try {
            node = JSON.readTree(block.data());
        } catch (IOException e) {
            return Read.refused(NOT_ANSWERS);
        }
        return json(node);
    }

    /** The machine block's JSON - also what the MCP server sends after reading a file itself. */
    public static Read json(JsonNode node) {
        if (node == null || !node.isObject()) {
            return Read.refused(NOT_ANSWERS);
        }
        if (!node.path("version").canConvertToInt() || node.path("version").asInt() != VERSION) {
            String v = node.path("version").isMissingNode() || node.path("version").isNull() ? "none" : node.path("version").asText();
            return Read.refused("Unknown answers file version " + (v.length() > 20 ? v.substring(0, 20) : v));
        }
        String formId = node.path("formId").asText("");
        if (!FORM_ID.matcher(formId).matches() || !node.path("answers").isArray() || node.path("answers").size() > MAX_ANSWERS) {
            return Read.refused(NOT_ANSWERS);
        }
        List<Answer> answers = new ArrayList<>();
        for (JsonNode a : node.path("answers")) {
            String q = a.path("q").asText("");
            if (!a.isObject() || !ID.matcher(q).matches()) {
                return Read.refused(NOT_ANSWERS);
            }
            List<String> choice = ids(a.path("choice"));
            if (choice == null) {
                return Read.refused(NOT_ANSWERS);
            }
            Follow follow = null;
            JsonNode f = a.path("follow");
            if (f.isObject()) {
                List<String> fc = ids(f.path("choice"));
                if (fc == null || !ID.matcher(f.path("q").asText("")).matches()) {
                    return Read.refused(NOT_ANSWERS);
                }
                follow = new Follow(f.path("q").asText(), fc);
            }
            String note = a.path("note").isTextual() ? a.path("note").asText().strip() : "";
            if (note.length() > MAX_NOTE) {
                return Read.refused("A note is at most " + MAX_NOTE + " characters");
            }
            String sure = a.path("sure").isTextual() ? a.path("sure").asText() : null;
            sure = sure != null && List.of("sure", "likely", "unsure").contains(sure) ? sure : null;
            answers.add(new Answer(q, choice, a.path("other").asBoolean(false), a.path("later").asBoolean(false), note, sure, follow));
        }
        Instant at = null;
        try {
            at = node.hasNonNull("answeredAt") ? Instant.parse(node.get("answeredAt").asText()) : null;
        } catch (RuntimeException e) {
            // not a time: unknown
        }
        String lang = node.path("lang").asText("");
        return new Read(new Parsed(formId, VERSION, cut(node.path("board").asText(""), 120), lang.equals("ar") || lang.equals("en") ? lang : null,
                cut(node.path("answeredBy").asText("").strip(), MAX_NAME), cut(node.path("role").asText("").strip(), MAX_NAME), at, answers), null);
    }

    /** Option ids, or null when the value is not a short list of them. */
    private static List<String> ids(JsonNode node) {
        if (node.isMissingNode() || node.isNull()) {
            return List.of();
        }
        if (!node.isArray() || node.size() > 20) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (JsonNode c : node) {
            if (!c.isTextual() || !ID.matcher(c.asText()).matches()) {
                return null;
            }
            out.add(c.asText());
        }
        return out;
    }

    private static String cut(String s, int max) {
        return s.length() > max ? s.substring(0, max) : s;
    }

    // ---------------------------------------------------------------------------------------------------------------- zip

    private record Unzipped(String html, String problem) {
    }

    private static Unzipped unzip(byte[] data) {
        String html = null;
        int entries = 0;
        try (ZipInputStream z = new ZipInputStream(new ByteArrayInputStream(data), StandardCharsets.UTF_8)) {
            ZipEntry e;
            while ((e = z.getNextEntry()) != null) {
                if (++entries > MAX_ENTRIES) {
                    return new Unzipped(null, BAD_ZIP);
                }
                String name = e.getName().replace('\\', '/');
                if (name.startsWith("/") || name.contains("../") || name.equals("..") || name.matches("^[A-Za-z]:.*")) {
                    return new Unzipped(null, BAD_ZIP);
                }
                if (e.isDirectory() || name.startsWith("__MACOSX/") || name.substring(name.lastIndexOf('/') + 1).startsWith("._")) {
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                if (!lower.endsWith(".html") && !lower.endsWith(".htm")) {
                    return new Unzipped(null, BAD_ZIP);
                }
                if (html != null) {
                    return new Unzipped(null, BAD_ZIP);
                }
                byte[] bytes = capped(z);
                if (bytes == null) {
                    return new Unzipped(null, TOO_BIG);
                }
                html = new String(bytes, StandardCharsets.UTF_8);
            }
        } catch (IOException | IllegalArgumentException e) {
            // encrypted entries, a broken archive, a bad name encoding
            return new Unzipped(null, BAD_ZIP);
        }
        return html == null ? new Unzipped(null, BAD_ZIP) : new Unzipped(html, null);
    }

    /** The entry's bytes, read until the limit and no further; null past it. */
    private static byte[] capped(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_BYTES) {
                return null;
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
