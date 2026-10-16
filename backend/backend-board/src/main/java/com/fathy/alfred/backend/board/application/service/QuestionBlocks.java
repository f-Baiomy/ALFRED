package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.QuestionsUseCase.AnswerIn;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The text of Claude's questions and the user's answers (specs/019, docs/board.md "Questions"). A question comment is
 * {@code **Question** <the first question>} and, when Claude asked with options, a {@code ```questions} block of JSON:
 * <pre>{"about": 687, "because": {"entry": 688, "header": "Steps"},
 *  "questions": [{"header": "Steps", "question": "…", "why": "…", "multiSelect": false,
 *                 "options": [{"label": "…", "description": "…", "then": "…", "recommended": true, "preview": "…",
 *                              "confidence": "high", "followUp": {"header": "Plan", "question": "…", "options": […]}}],
 *                 "checked": "…", "severity": {"rank": 1, "of": 4, "note": "…"}, "group": [14, 17]}]}</pre>
 * {@code confidence} (on the recommended option: high, medium or low), {@code checked}, {@code severity} and {@code group}
 * are triage's (the Inbox worst first, cards of one root cause to merge into this one) - all optional.
 * An answer is {@code **Answers** Steps: … · Checks: …} with a {@code ```answers} block: {@code {"Steps": {"chose":
 * ["…"], "other": "…", "note": "…", "later": "<instant>"}}}. The text stays the source of truth - this reads it.
 */
final class QuestionBlocks {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern FENCE = Pattern.compile("(?ms)^```(questions|answers)[ \\t]*\\n(.*?)\\n```[ \\t]*$");
    static final int MAX_QUESTIONS = 4;
    static final int MAX_OPTIONS = 4;

    private QuestionBlocks() {
    }

    /** One question as asked: its place, its header, its options; a follow-up names the question and option that open it. */
    record Asked(int idx, String header, String question, boolean multiSelect, List<String> options, Integer parentIdx, String parentOption,
                 String recommended, String adviceMeta) {

        Asked(int idx, String header, String question, boolean multiSelect, List<String> options, Integer parentIdx, String parentOption) {
            this(idx, header, question, multiSelect, options, parentIdx, parentOption, null, null);
        }
    }

    static final List<String> CONFIDENCE = List.of("high", "medium", "low");

    /** The questions a question comment asks, follow-ups after the questions; a comment with no block asks one, its text. */
    static List<Asked> asked(String text) {
        Optional<JsonNode> block = block(text, "questions");
        if (block.isEmpty() || !block.get().path("questions").isArray() || block.get().path("questions").isEmpty()) {
            String plain = text == null ? "" : text.replaceFirst("^\\*\\*Question\\*\\*\\s*", "").strip();
            return List.of(new Asked(0, "Question", plain, false, List.of(), null, null));
        }
        List<Asked> top = new ArrayList<>();
        List<Asked> follow = new ArrayList<>();
        JsonNode qs = block.get().path("questions");
        for (int i = 0; i < qs.size(); i++) {
            top.add(of(qs.get(i), i, null, null));
        }
        int next = top.size();
        for (int i = 0; i < qs.size(); i++) {
            for (JsonNode option : qs.get(i).path("options")) {
                JsonNode f = option.path("followUp");
                if (f.isObject()) {
                    follow.add(of(f, next++, i, option.path("label").asText("")));
                }
            }
        }
        List<Asked> all = new ArrayList<>(top);
        all.addAll(follow);
        return all;
    }

    private static Asked of(JsonNode q, int idx, Integer parentIdx, String parentOption) {
        List<String> options = new ArrayList<>();
        String[] recommended = {null};
        String[] confidence = {null};
        String[] reason = {null};
        q.path("options").forEach(o -> {
            options.add(o.path("label").asText(""));
            if (recommended[0] == null && o.path("recommended").asBoolean(false)) {
                recommended[0] = o.path("label").asText("");
                String c = o.path("confidence").asText("").strip().toLowerCase(Locale.ROOT);
                confidence[0] = CONFIDENCE.contains(c) ? c.toUpperCase(Locale.ROOT) : null;
                reason[0] = text(o, "description");
            }
        });
        String header = q.path("header").asText("").strip();
        return new Asked(idx, header.isEmpty() ? "Q" + (idx + 1) : header, q.path("question").asText("").strip(), q.path("multiSelect").asBoolean(false),
                options, parentIdx, parentOption, recommended[0], recommended[0] == null ? null : meta(q, confidence[0], reason[0]));
    }

    /** The triage facts of a question with a recommended option, as the JSON the index keeps, or null when it has none. */
    private static String meta(JsonNode q, String confidence, String optionReason) {
        ObjectNode m = JSON.createObjectNode();
        if (confidence != null) {
            m.put("confidence", confidence);
        }
        // why Claude advises it: the recommended option's own description, else why it asks - the tile shows it
        String reason = optionReason != null ? optionReason : text(q, "why");
        if (reason != null) {
            m.put("reason", oneLine(reason, 400));
        }
        String checked = text(q, "checked");
        if (checked != null) {
            m.put("checked", oneLine(checked, 600));
        }
        JsonNode sev = q.path("severity");
        if (sev.path("rank").canConvertToInt() && sev.path("rank").asInt() > 0) {
            ObjectNode s = m.putObject("severity");
            s.put("rank", sev.path("rank").asInt());
            if (sev.path("of").canConvertToInt() && sev.path("of").asInt() > 0) {
                s.put("of", sev.path("of").asInt());
            }
            String note = text(sev, "note");
            if (note != null) {
                s.put("note", oneLine(note, 200));
            }
        }
        if (q.path("group").isArray() && !q.path("group").isEmpty()) {
            var g = m.putArray("group");
            q.path("group").forEach(n -> {
                if (n.canConvertToInt() && n.asInt() > 0) {
                    g.add(n.asInt());
                }
            });
        }
        return m.isEmpty() ? null : m.toString();
    }

    /** What is wrong with a ```questions block Claude wrote, or null. */
    static String problem(String text) {
        Optional<JsonNode> block = block(text, "questions");
        if (text != null && text.contains("```questions") && block.isEmpty()) {
            return "The ```questions block is not valid JSON";
        }
        if (block.isEmpty()) {
            return null;
        }
        JsonNode qs = block.get().path("questions");
        if (!qs.isArray() || qs.isEmpty() || qs.size() > MAX_QUESTIONS) {
            return "Ask 1 to " + MAX_QUESTIONS + " questions at once";
        }
        List<String> headers = new ArrayList<>();
        for (Asked a : asked(text)) {
            if (a.question().isBlank()) {
                return "Question " + a.header() + " has no text";
            }
            if (headers.contains(a.header().toLowerCase(Locale.ROOT))) {
                return "Two questions share the header \"" + a.header() + "\" - each needs its own";
            }
            headers.add(a.header().toLowerCase(Locale.ROOT));
            if (a.options().size() > MAX_OPTIONS || a.options().stream().anyMatch(String::isBlank)) {
                return "Question " + a.header() + ": give 2 to " + MAX_OPTIONS + " options, each with a label (Something else is always added)";
            }
            if (a.options().size() == 1) {
                return "Question " + a.header() + " has one option - give 2 to " + MAX_OPTIONS + ", or none for a free answer";
            }
        }
        for (JsonNode q : qs) {
            String header = q.path("header").asText("").strip();
            for (JsonNode o : q.path("options")) {
                String c = o.path("confidence").asText("").strip().toLowerCase(Locale.ROOT);
                if (o.has("confidence") && !CONFIDENCE.contains(c)) {
                    return "Question " + header + ": confidence is high, medium or low";
                }
                if (o.has("confidence") && !o.path("recommended").asBoolean(false)) {
                    return "Question " + header + ": confidence goes on the recommended option";
                }
            }
            JsonNode sev = q.path("severity");
            if (q.has("severity") && !(sev.path("rank").canConvertToInt() && sev.path("rank").asInt() > 0)) {
                return "Question " + header + ": severity needs a rank of 1 or more (1 = worst)";
            }
            if (q.has("group")) {
                boolean ok = q.path("group").isArray();
                for (JsonNode n : q.path("group")) {
                    ok &= n.canConvertToInt() && n.asInt() > 0;
                }
                if (!ok) {
                    return "Question " + header + ": group is a list of card numbers";
                }
            }
        }
        return null;
    }

    /** The user's answers in an answer comment, by header. */
    static Map<String, AnswerIn> answers(String text) {
        Map<String, AnswerIn> out = new LinkedHashMap<>();
        block(text, "answers").ifPresent(node -> node.fields().forEachRemaining(e -> {
            JsonNode v = e.getValue();
            List<String> chose = new ArrayList<>();
            v.path("chose").forEach(c -> chose.add(c.asText()));
            Instant later = null;
            try {
                later = v.hasNonNull("later") ? Instant.parse(v.get("later").asText()) : null;
            } catch (RuntimeException ignored) {
                // not a time: no "later"
            }
            out.put(e.getKey(), new AnswerIn(chose, text(v, "other"), text(v, "note"), later));
        }));
        return out;
    }

    /** {@code **Answers** Steps: Keep all the steps · Checks: A, B} and the block - the comment one send writes for one question comment. */
    static String answerText(Map<String, AnswerIn> answers) {
        List<String> parts = new ArrayList<>();
        ObjectNode block = JSON.createObjectNode();
        answers.forEach((header, a) -> {
            ObjectNode v = block.putObject(header);
            if (a.later() != null) {
                v.put("later", a.later().toString());
                parts.add(header + ": later");
                return;
            }
            v.putArray("chose").addAll(a.chose().stream().map(JSON::valueToTree).map(JsonNode.class::cast).toList());
            if (a.other() != null) {
                v.put("other", a.other());
            }
            if (a.note() != null) {
                v.put("note", a.note());
            }
            List<String> said = new ArrayList<>(a.chose());
            if (a.other() != null) {
                said.add("\"" + oneLine(a.other()) + "\"");
            }
            parts.add(header + ": " + String.join(", ", said) + (a.note() == null ? "" : " (note: " + oneLine(a.note()) + ")"));
        });
        return "**Answers** " + String.join(" · ", parts) + "\n\n```answers\n" + block.toPrettyString() + "\n```";
    }

    /** The same question asked again: its words, without case, marks or spacing. */
    static String sameness(String question) {
        return question == null ? "" : question.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+", " ").strip();
    }

    private static Optional<JsonNode> block(String text, String lang) {
        if (text == null) {
            return Optional.empty();
        }
        Matcher m = FENCE.matcher(text);
        while (m.find()) {
            if (m.group(1).equals(lang)) {
                try {
                    JsonNode node = JSON.readTree(m.group(2));
                    return node != null && node.isObject() ? Optional.of(node) : Optional.empty();
                } catch (Exception e) {
                    return Optional.empty();
                }
            }
        }
        return Optional.empty();
    }

    private static String text(JsonNode v, String field) {
        String s = v.hasNonNull(field) ? v.get(field).asText().strip() : "";
        return s.isEmpty() ? null : s;
    }

    private static String oneLine(String s) {
        return oneLine(s, 200);
    }

    private static String oneLine(String s, int max) {
        String flat = s.replaceAll("\\s+", " ").strip();
        return flat.length() > max ? flat.substring(0, max - 1) + "…" : flat;
    }
}
