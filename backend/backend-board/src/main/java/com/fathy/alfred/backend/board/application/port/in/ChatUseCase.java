package com.fathy.alfred.backend.board.application.port.in;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The board chats (specs/022): the user writes, Claude takes and answers once, and records on the board what another
 * session needs. Claude's board limits apply to every record. One port for the whole slice of chat - the methods share
 * the same rules (who may do what to a message in which state).
 */
public interface ChatUseCase {

    int MAX_PAGE = 100;
    int DEFAULT_PAGE = 50;
    int MAX_SEARCH = 200;
    int MAX_QUERY = 200;

    /** The outcome of a chat write: OK with its value, or why not (the board's refusal outcomes). */
    record Result<T>(CardChange.Outcome outcome, T value, String message) {

        public static <T> Result<T> ok(T value) {
            return new Result<>(CardChange.Outcome.OK, value, null);
        }

        public static <T> Result<T> no(CardChange.Outcome outcome, String message) {
            return new Result<>(outcome, null, message);
        }

        public boolean isOk() {
            return outcome == CardChange.Outcome.OK;
        }
    }

    // ------------------------------------------------------------------------------------------------------------ reads

    /** A bar row with what only the running Alfred knows: whether Claude is on, typing, the terminal's state. */
    record Row(ChatSummary summary, boolean claudeOn, boolean typing, ChatSession session) {
    }

    List<Row> chats(String project);

    record Page(List<ChatMessage> messages, boolean more, Map<Long, List<ChatRecord>> records) {
    }

    Page page(ChatKey chat, Long before, int limit);

    Optional<ChatMessage> message(long id);

    /** Claude's current answer to a message (not one asked again). */
    Optional<ChatMessage> answerOf(long id);

    record Hit(long id, Long parentId, boolean folded) {
    }

    List<Hit> search(ChatKey chat, String query, String filter);

    ChatSettings settings(ChatKey chat);

    List<TerminalItem> terminal(ChatKey chat);

    /** What a new session needs to continue (handover, task_context): the latest summary, what came after, decisions, open terminal items. */
    record Handover(ChatMessage summary, List<ChatMessage> after, List<ChatMessage> decisions, List<TerminalItem> terminal, ChatSession session) {
    }

    Handover handover(ChatKey chat);

    /** A page of the project's chats (or one cycle's, {@code cycleId} "" = the project chat) as board-file records (specs/022 T052). */
    record ExportPage(List<JsonNode> lines, long next, boolean more) {
    }

    ExportPage exportChats(String project, String cycleId, long after, int limit);

    // ----------------------------------------------------------------------------------------------------- user writes

    record Post(String text, Long parentId, List<MentionRef> context, String quote, boolean urgent, String origin, List<String> imageIds) {
    }

    Result<ChatMessage> post(Actor actor, ChatKey chat, Post post);

    Result<ChatMessage> edit(Actor actor, long id, String text);

    Result<ChatMessage> cancel(Actor actor, long id);

    Result<ChatMessage> urgent(Actor actor, long id);

    Result<ChatMessage> compact(Actor actor, ChatKey chat);

    Result<ChatSettings> putSettings(Actor actor, ChatSettings settings);

    Result<Void> undoRecord(Actor actor, long recordId);

    Result<Void> undoTerminal(Actor actor, long itemId);

    /** "Refresh from session": the runner re-copies the terminal session before the next answer. */
    Result<Void> refresh(Actor actor, ChatKey chat);

    /** The reactions a chat message takes: the board's, plus ❓ ("explain more", FR-044). */
    Set<String> REACTIONS = Set.of("👍", "✅", "🤔", "👀", "🎉", "❌", "❓");

    /** ★ (FR-024): marks a message a decision - the same DECISION record an answer makes (brief + Undo); off undoes it. */
    Result<ChatMessage> decision(Actor actor, long id, boolean on);

    /** Toggles the user's reaction; ❓ on Claude's answer also asks Claude to explain more, in the thread (FR-044). */
    Result<ChatMessage> react(Actor actor, long id, String emoji);

    /**
     * The user's answers to Claude's questions on one answer (FR-025), by question header, sent once: each is stored on its
     * question and they go back to Claude together as one message in the thread. Questions not answered stay open.
     */
    Result<ChatMessage> answer(Actor actor, long answerId, Map<String, String> answers);

    record AskAgain(boolean logs, boolean sql, boolean items, String text) {
    }

    /** ↻ (FR-045): Claude's answer stays, marked asked again; the question goes back with more to read. */
    Result<ChatMessage> again(Actor actor, long answerId, AskAgain ask);

    /** {@code mention}: type (lower case), ref and label - drawn with the board's mention chip. */
    record SharedRef(Map<String, String> mention, long messageId, Instant at) {
    }

    record SharedGroup(String type, List<SharedRef> refs) {
    }

    /** 🗂 Shared (FR-043): everything the chat mentions, folded messages included, each once with its first message. */
    List<SharedGroup> shared(ChatKey chat);

    /** What changed on the board since the user last looked (FR-023), built without a model; empty when nothing did. */
    record Digest(List<String> lines, Instant since) {
    }

    Optional<Digest> digest(ChatKey chat, Instant since);

    // -------------------------------------------------------------------------------------------------- Claude's writes

    /** What a take hands over: the message, its thread, the chat's latest summary. */
    record Taken(ChatMessage message, List<ChatMessage> thread, ChatMessage summary) {
    }

    /** {@code cycleId}: the cycle the taking runner holds, null for the project's live runner. */
    Result<Taken> take(Actor actor, long id, String chatId, String cycleId);

    record RecordRequest(ChatRecord.Kind kind, String text, NewCardPart card, ItemPart item, FixPart fix) {
    }

    record NewCardPart(String kind, String title, String description) {
    }

    record ItemPart(String file, String text, String evidence) {
    }

    record FixPart(int card, String report, String plan) {
    }

    record ToTerminal(String text, boolean urgent, String reason, boolean mirror) {
    }

    record Reply(String text, List<RecordRequest> records, List<ToTerminal> toTerminal, JsonNode extra, Long updateId) {
    }

    record Replied(ChatMessage message, List<ChatRecord> records, List<TerminalItem> terminal) {
    }

    Result<Replied> reply(Actor actor, long id, Reply reply);

    Result<ChatMessage> summary(Actor actor, ChatKey chat, String text, long coversTo);

    Result<ChatSession> putSession(Actor actor, ChatKey chat, String chatSessionId, String forkedFrom, String host, Instant forkedAt,
                                   Instant seenUpTo);

    Result<List<TerminalItem>> addTerminal(Actor actor, ChatKey chat, List<ToTerminal> items);

    Result<Void> delivered(Actor actor, List<Long> ids, boolean read);

    /** The runner could not finish: back to waiting (runner restart) or stopped / failed with a line saying why. */
    Result<ChatMessage> release(Actor actor, long id, boolean failed, String why);

    /** A line from the runner in the chat ("↻ caught up", "↳ answered your comment on #12") - no answer, no record. */
    Result<ChatMessage> systemLine(Actor actor, ChatKey chat, String text);

    Result<ChatWatch> watch(Actor actor, ChatKey chat, ChatWatch.Kind kind, String target, String label, Long messageId);

    Result<Void> cancelWatch(Actor actor, long id);

    /** The chat's open "tell me when" watches (FR-031: listed with a remove control). */
    List<ChatWatch> watches(ChatKey chat);
}
