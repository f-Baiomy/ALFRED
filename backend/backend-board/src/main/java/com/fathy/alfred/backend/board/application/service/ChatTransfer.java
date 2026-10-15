package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The board chats in the board's {@code alfred-board/1} file (specs/022 FR-012, T052): records {@code chat} (a message),
 * {@code chatRecord}, {@code chatTerminal} and {@code chatSettings}. Sessions never travel - they belong to a machine.
 * Written and read here so the shape has one owner; the frontend only copies the lines into the file.
 *
 * <p>On import a message still waiting or taken comes back STOPPED (nobody here asked this Claude for it), a record
 * keeps its line but cannot be undone (its card or brief belongs to the other board), terminal items come back read.
 * A cycle chat whose cycle does not exist here lands in the project chat, each message marked with the cycle's name.
 */
final class ChatTransfer {

    static final int EXPORT_PAGE = 200;

    private final ObjectMapper json = new ObjectMapper();
    private final ChatStorePort chats;
    private final CycleNamesPort cycles;

    ChatTransfer(ChatStorePort chats, CycleNamesPort cycles) {
        this.chats = chats;
        this.cycles = cycles;
    }

    record Page(List<JsonNode> lines, long next, boolean more) {
    }

    /** One page of the project's chats (or one cycle's) as file records: settings of each chat first, then messages, records, items. */
    Page export(String project, String cycleId, long after, int limit) {
        int n = Math.max(1, Math.min(limit, EXPORT_PAGE));
        List<ChatMessage> messages = chats.exportPage(project, cycleId, after, n + 1);
        boolean more = messages.size() > n;
        if (more) {
            messages = messages.subList(0, n);
        }
        List<JsonNode> lines = new ArrayList<>();
        Set<ChatKey> keys = new LinkedHashSet<>();
        Map<String, String> names = new HashMap<>();
        for (ChatMessage m : messages) {
            if (keys.add(m.chat())) {
                ChatSettings s = chats.settings(m.chat());
                if (!s.equals(ChatSettings.defaults(m.chat()))) {
                    lines.add(json.createObjectNode().put("record", "chatSettings").put("cycleId", s.chat().cycleId())
                            .put("autoN", s.autoN()).put("digestGapMin", s.digestGapMin()).put("watching", s.watching()));
                }
            }
            ObjectNode line = message(m);
            if (!m.chat().isProject()) {
                line.put("cycleName", names.computeIfAbsent(m.chat().cycleId(), id -> cycles == null ? "" : cycles.nameOf(id).orElse("")));
            }
            lines.add(line);
        }
        List<Long> ids = messages.stream().map(ChatMessage::id).toList();
        for (ChatRecord r : chats.recordsOf(ids)) {
            lines.add(json.createObjectNode().put("record", "chatRecord").put("messageId", r.messageId()).put("kind", r.kind().name())
                    .put("line", r.line()).put("at", r.createdAt().toString()).put("undone", r.undone()));
        }
        for (TerminalItem t : chats.terminalOf(ids)) {
            lines.add(json.createObjectNode().put("record", "chatTerminal").put("messageId", t.messageId()).put("cycleId", t.chat().cycleId())
                    .put("urgent", t.urgent()).put("mirror", t.mirror()).put("text", t.text()).put("reason", t.reason())
                    .put("state", t.state().name()).put("at", t.createdAt().toString()));
        }
        return new Page(lines, messages.isEmpty() ? after : messages.get(messages.size() - 1).id(), more);
    }

    private ObjectNode message(ChatMessage m) {
        ObjectNode o = json.createObjectNode().put("record", "chat").put("id", m.id()).put("cycleId", m.chat().cycleId());
        if (m.parentId() != null) {
            o.put("parentId", m.parentId());
        }
        o.put("author", m.author().name()).put("kind", m.kind().name()).put("text", m.text()).put("state", m.state().name())
                .put("urgent", m.urgent()).put("decision", m.decision());
        o.put("origin", m.origin()).put("quote", m.quote());
        o.set("context", json.valueToTree(m.context()));
        if (m.extra() != null && !m.extra().isNull()) {
            o.set("extra", m.extra());
        }
        if (!m.reactions().isEmpty()) {
            o.set("reactions", json.valueToTree(m.reactions()));
        }
        if (m.coversTo() != null) {
            o.put("coversTo", m.coversTo());
        }
        if (m.replyTo() != null) {
            o.put("replyTo", m.replyTo());
        }
        o.put("bridgeFrom", m.bridgeFrom()).put("superseded", m.superseded()).put("at", m.createdAt().toString());
        if (m.editedAt() != null) {
            o.put("editedAt", m.editedAt().toString());
        }
        return o;
    }

    /** Reads one import's chat records in file order (messages before what refers to them). */
    final class Importer {

        private final String target;
        private final BoardStorePort store;
        private final java.util.function.UnaryOperator<String> rewrite;
        private final Map<Long, Long> ids = new HashMap<>();
        private final Map<Long, ChatKey> chatOf = new HashMap<>();
        private final Map<String, Boolean> known = new HashMap<>();
        private int count;
        private boolean liveCalls;

        Importer(String target, BoardStorePort store, java.util.function.UnaryOperator<String> rewrite) {
            this.target = target;
            this.store = store;
            this.rewrite = rewrite;
        }

        int count() {
            return count;
        }

        boolean mentionsLiveCalls() {
            return liveCalls;
        }

        private boolean here(String cycleId) {
            return cycleId.isEmpty() || known.computeIfAbsent(cycleId, id -> cycles != null && cycles.nameOf(id).isPresent());
        }

        void accept(JsonNode r) {
            switch (r.path("record").asText()) {
                case "chat" -> message(r);
                case "chatRecord" -> record(r);
                case "chatTerminal" -> terminal(r);
                case "chatSettings" -> settings(r);
                default -> {
                }
            }
        }

        private void message(JsonNode r) {
            String cycleId = r.path("cycleId").asText("");
            String text = RichText.clean(rewrite.apply(r.path("text").asText("")));
            if (!here(cycleId)) {
                String name = r.path("cycleName").asText("").isBlank() ? cycleId : r.path("cycleName").asText();
                text = "*[from cycle " + name.replace("]", ")") + "]* " + text;
                cycleId = "";
            }
            if (text.length() > ChatMessage.MAX_TEXT) {
                return;
            }
            ChatKey chat = new ChatKey(target, cycleId);
            ChatMessage.State state = enumOf(ChatMessage.State.class, r.path("state").asText(), ChatMessage.State.DONE);
            if (state == ChatMessage.State.WAITING || state == ChatMessage.State.TAKEN) {
                state = ChatMessage.State.STOPPED;
            }
            List<String> context = new ArrayList<>();
            r.path("context").forEach(c -> context.add(c.asText()));
            Map<String, Integer> reactions = new HashMap<>();
            r.path("reactions").fields().forEachRemaining(e -> reactions.put(e.getKey(), e.getValue().asInt()));
            ChatMessage saved = chats.insert(new ChatMessage(0, chat, mapped(r, "parentId"),
                    enumOf(ChatMessage.Author.class, r.path("author").asText(), ChatMessage.Author.USER),
                    enumOf(ChatMessage.Kind.class, r.path("kind").asText(), ChatMessage.Kind.TEXT), text, state,
                    r.path("urgent").asBoolean(false), r.path("decision").asBoolean(false), textOrNull(r, "origin"), context,
                    textOrNull(r, "quote"), r.hasNonNull("extra") ? r.get("extra") : null, reactions, mapped(r, "coversTo"),
                    mapped(r, "replyTo"), textOrNull(r, "bridgeFrom"), r.path("superseded").asBoolean(false), instant(r, "at"),
                    r.hasNonNull("editedAt") ? instant(r, "editedAt") : null));
            ids.put(r.path("id").asLong(), saved.id());
            chatOf.put(saved.id(), chat);
            count++;
            var refs = MentionParser.mentions(RichText.plain(text));
            if (!refs.isEmpty()) {
                store.replaceMentions(MentionOwner.CHAT, String.valueOf(saved.id()), null, refs);
                liveCalls |= refs.stream().anyMatch(x -> x.liveCallId() != null);
            }
        }

        private void record(JsonNode r) {
            Long messageId = ids.get(r.path("messageId").asLong());
            ChatRecord.Kind kind = enumOf(ChatRecord.Kind.class, r.path("kind").asText(), null);
            if (messageId == null || kind == null) {
                return;
            }
            ChatRecord saved = chats.insertRecord(new ChatRecord(0, messageId, kind, null, r.path("line").asText(""),
                    "{\"imported\":true}", instant(r, "at"), null));
            if (r.path("undone").asBoolean(false)) {
                chats.markRecordUndone(saved.id());
            }
        }

        private void terminal(JsonNode r) {
            Long messageId = ids.get(r.path("messageId").asLong());
            if (messageId == null) {
                return;
            }
            TerminalItem.State state = "UNDONE".equals(r.path("state").asText()) ? TerminalItem.State.UNDONE : TerminalItem.State.READ;
            chats.insertTerminalItem(new TerminalItem(0, chatOf.get(messageId), messageId, r.path("urgent").asBoolean(false),
                    r.path("mirror").asBoolean(false), r.path("text").asText(""), textOrNull(r, "reason"), state, instant(r, "at"), null, null));
        }

        private void settings(JsonNode r) {
            String cycleId = r.path("cycleId").asText("");
            if (!here(cycleId)) {
                return; // the project chat keeps its own settings
            }
            ChatKey chat = new ChatKey(target, cycleId);
            if (!chats.settings(chat).equals(ChatSettings.defaults(chat))) {
                return; // this board's own choice wins
            }
            int autoN = r.path("autoN").asInt(ChatSettings.DEFAULT_AUTO_N);
            int gap = r.path("digestGapMin").asInt(ChatSettings.DEFAULT_DIGEST_GAP_MIN);
            chats.putSettings(new ChatSettings(chat, autoN == 0 ? 0 : Math.max(ChatSettings.MIN_AUTO_N, Math.min(ChatSettings.MAX_AUTO_N, autoN)),
                    Math.max(ChatSettings.MIN_DIGEST_GAP_MIN, Math.min(ChatSettings.MAX_DIGEST_GAP_MIN, gap)), r.path("watching").asBoolean(false)));
        }

        private Long mapped(JsonNode r, String field) {
            return r.hasNonNull(field) ? ids.get(r.path(field).asLong()) : null;
        }
    }

    private static String textOrNull(JsonNode r, String field) {
        return r.hasNonNull(field) ? r.path(field).asText() : null;
    }

    private static Instant instant(JsonNode r, String field) {
        try {
            return Instant.parse(r.path(field).asText());
        } catch (RuntimeException e) {
            return Instant.now();
        }
    }

    private static <E extends Enum<E>> E enumOf(Class<E> type, String name, E fallback) {
        try {
            return Enum.valueOf(type, name);
        } catch (RuntimeException e) {
            return fallback;
        }
    }
}
