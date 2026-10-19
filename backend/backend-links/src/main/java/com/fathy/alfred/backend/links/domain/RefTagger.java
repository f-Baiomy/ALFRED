package com.fathy.alfred.backend.links.domain;

import java.util.Deque;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Gives ids read through a link their {@code @slug} (R1), so whatever is read next - by a page, by Claude through the MCP
 * server, by the board's own judging - goes back over the same link. Only Alfred's own id fields are tagged (a short,
 * fixed list), and mentions in board text ({@code @[call:<id>|…]}); call data itself - headers, bodies, database rows,
 * Redis arguments, log lines - is never touched, so an export of a streamed call is byte for byte what the owner has.
 */
public final class RefTagger implements JsonRewriter.Visitor {

    /** Fields that hold one of Alfred's ids (or a list of them). */
    public static final Set<String> ID_FIELDS = Set.of("id", "callId", "callIds", "cycleId", "cycleIds", "parentId", "parentCallId",
            "capturedCallId", "internalCallId", "originalCallId", "sourceCallId", "statementId", "statementIds", "sessionCycleId",
            "boardId", "boardIds", "cardId", "cardIds", "homeCycleId", "homeBoardId", "commandId", "storeCommandId", "spacerId",
            "afterCallId", "evidenceCallId", "taskKey", "relatedCycleId");

    /** Containers of the owner's data, copied untouched. */
    public static final Set<String> DATA_FIELDS = Set.of("headers", "requestHeaders", "responseHeaders", "request", "response",
            "requestBody", "responseBody", "body", "bodyJson", "rawBody", "rows", "row", "columns", "values", "params", "parameters",
            "args", "arguments", "reply", "before", "after", "valueBefore", "data", "payload", "mdc", "fields", "line", "lines",
            "message", "stackTrace", "sql", "query", "exception", "cookies", "variables", "snapshot", "answer");

    private static final Pattern MENTION = Pattern.compile("@\\[([a-z_]+):([^\\]|\\r\\n]+)(\\||\\])");

    private final String slug;
    private final Set<String> textFields;
    private final Set<String> keyIds;

    /** @param textFields fields whose text may hold mentions (descriptions, comments, briefs) */
    public RefTagger(String slug, Set<String> textFields) {
        this(slug, textFields, Set.of());
    }

    private RefTagger(String slug, Set<String> textFields, Set<String> keyIds) {
        this.slug = slug;
        this.textFields = textFields;
        this.keyIds = keyIds;
    }

    /**
     * The same tagger, also tagging the top-level keys that are these ids - the asked ids of a "counts by id" answer
     * ({@code {"<callId>": {...}}}), which a page looks up by the ids it asked with.
     */
    public RefTagger withKeys(Set<String> ids) {
        return new RefTagger(slug, textFields, Set.copyOf(ids));
    }

    @Override
    public String fieldName(Deque<String> path, String field) {
        return path.isEmpty() && keyIds.contains(field) ? tagId(field) : field;
    }

    public RefTagger(String slug) {
        this(slug, Set.of("text", "description", "brief", "comment", "note", "evidence", "summary", "content", "title", "markdown"));
    }

    @Override
    public boolean descend(Deque<String> path, String field) {
        return !DATA_FIELDS.contains(field);
    }

    @Override
    public String string(Deque<String> path, String value) {
        String field = field(path);
        if (field != null && ID_FIELDS.contains(field)) {
            return tagId(value);
        }
        if ("ref".equals(field) && !value.isBlank() && value.length() <= 2000 && value.chars().noneMatch(c -> c <= ' ' || c == '|' || c == ']')) {
            // a mention or link ({type, ref, label}) - tagged exactly as a mention in text is
            return RemoteRef.append(value, slug);
        }
        if (field != null && textFields.contains(field) && value.contains("@[")) {
            return tagMentions(value);
        }
        return value;
    }

    /** The field a value belongs to: the last name in the path, skipping array levels. */
    private static String field(Deque<String> path) {
        Iterator<String> it = path.descendingIterator();
        while (it.hasNext()) {
            String f = it.next();
            if (!"[]".equals(f)) {
                return f;
            }
        }
        return null;
    }

    public String tagId(String value) {
        if (value == null || value.isEmpty() || value.length() > 200 || value.chars().anyMatch(c -> c <= ' ' || c == '/' || c == '|' || c == ']')) {
            return value;
        }
        return RemoteRef.append(value, slug);
    }

    public String tagMentions(String text) {
        Matcher m = MENTION.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(out, Matcher.quoteReplacement("@[" + m.group(1) + ":" + RemoteRef.append(m.group(2), slug) + m.group(3)));
        }
        m.appendTail(out);
        return out.toString();
    }
}
