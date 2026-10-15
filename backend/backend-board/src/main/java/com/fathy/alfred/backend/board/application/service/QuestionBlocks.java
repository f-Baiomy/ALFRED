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
 *                              "followUp": {"header": "Plan", "question": "…", "options": […]}}]}]}</pre>
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
    record Asked(int idx, String header, String question, boolean multiSelect, List<String> options, Integer parentIdx, String parentOption) {
    }

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
        q.path("options").forEach(o -> options.add(o.path("label").asText("")));
        String header = q.path("header").asText("").strip();
        return new Asked(idx, header.isEmpty() ? "Q" + (idx + 1) : header, q.path("question").asText("").strip(), q.path("multiSelect").asBoolean(false),
                options, parentIdx, parentOption);
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
        String flat = s.replaceAll("\\s+", " ").strip();
        return flat.length() > 200 ? flat.substring(0, 199) + "…" : flat;
    }
}
