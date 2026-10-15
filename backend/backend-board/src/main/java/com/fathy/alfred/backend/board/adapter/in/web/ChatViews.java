package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** The chats as the REST contract shows them (specs/022 contracts/rest-api.md): a chat named by project + scope. */
final class ChatViews {

    private ChatViews() {
    }

    record Message(long id, String project, String scope, Long parentId, String author, String kind, String text, String state, boolean urgent,
                   boolean decision, String origin, List<String> context, String quote, JsonNode extra, Map<String, Integer> reactions,
                   Long coversTo, Long replyTo, String bridgeFrom, boolean superseded, Instant createdAt, Instant editedAt,
                   List<Record> records) {
    }

    record Record(long id, long messageId, String kind, String target, String line, Instant createdAt, Instant undoneAt) {
    }

    record Terminal(long id, String project, String scope, Long messageId, boolean urgent, boolean mirror, String text, String reason,
                    String state, Instant createdAt, Instant deliveredAt, Instant readAt) {
    }

    record NeedsYou(int questions, int proposals, int confirms) {
    }

    record TerminalState(boolean open, Instant forkAt, Instant seenUpTo, Instant terminalAt, String host, String chatSessionId,
                         String forkedFrom) {
    }

    record Summary(String scope, String name, String kind, Long lastId, Instant lastAt, String lastPreview, String lastAuthor, int waiting,
                   boolean typing, NeedsYou needsYou, boolean claudeOn, TerminalState terminal) {
    }

    record Settings(int autoN, int digestGapMin, boolean watching) {
    }

    record Watch(long id, String project, String scope, String kind, String target, String label, Long messageId, Instant createdAt) {
    }

    static Message message(ChatMessage m, List<ChatRecord> records) {
        return new Message(m.id(), m.chat().project(), m.chat().scope(), m.parentId(), m.author().name(), m.kind().name(), m.text(),
                m.state().name(), m.urgent(), m.decision(), m.origin(), m.context(), m.quote(), m.extra(), m.reactions(), m.coversTo(),
                m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(), m.editedAt(),
                records == null ? List.of() : records.stream().map(ChatViews::record).toList());
    }

    static Message message(ChatMessage m) {
        return message(m, List.of());
    }

    static Record record(ChatRecord r) {
        return new Record(r.id(), r.messageId(), r.kind().name(), r.target(), r.line(), r.createdAt(), r.undoneAt());
    }

    static Terminal terminal(TerminalItem t) {
        return new Terminal(t.id(), t.chat().project(), t.chat().scope(), t.messageId(), t.urgent(), t.mirror(), t.text(), t.reason(),
                t.state().name(), t.createdAt(), t.deliveredAt(), t.readAt());
    }

    static Summary summary(ChatUseCase.Row row) {
        ChatSummary s = row.summary();
        ChatSession session = row.session();
        TerminalState terminal = !s.cycle() ? null : new TerminalState(session != null && session.forkedFrom() != null && row.claudeOn(),
                session == null ? null : session.forkedAt(), session == null ? null : session.seenUpTo(),
                session == null ? null : session.terminalAt(), session == null ? null : session.host(),
                session == null ? null : session.chatSessionId(), session == null ? null : session.forkedFrom());
        return new Summary(s.scope(), s.name(), s.cycle() ? "cycle" : "project", s.lastId(), s.lastAt(), s.lastPreview(), s.lastAuthor(),
                s.waiting(), row.typing(), new NeedsYou(s.questions(), s.proposals(), s.confirms()), row.claudeOn(), terminal);
    }

    static Settings settings(ChatSettings s) {
        return new Settings(s.autoN(), s.digestGapMin(), s.watching());
    }

    static Watch watch(ChatWatch w) {
        return new Watch(w.id(), w.chat().project(), w.chat().scope(), w.kind().name(), w.target(), w.label(), w.messageId(), w.createdAt());
    }
}
