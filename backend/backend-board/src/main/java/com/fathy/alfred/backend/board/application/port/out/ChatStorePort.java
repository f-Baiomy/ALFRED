package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.ChatChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** The board chats (specs/022, data-model.md), in board.db. Reads are windowed; nothing reads the whole store. */
public interface ChatStorePort {

    /** Stores a new message; returns it with its id. */
    ChatMessage insert(ChatMessage message);

    Optional<ChatMessage> find(long id);

    /** Writes a message's mutable fields back (text, state, urgent, decision, reactions, extra, superseded, edited). */
    void update(ChatMessage message);

    /**
     * Takes a waiting message for {@code taker} (a runner's chat id): only from WAITING, so two takes leave one winner.
     */
    boolean take(long id, String taker, java.time.Instant at);

    /** Who took a message, when it is TAKEN. */
    Optional<String> takenBy(long id);

    /**
     * Puts a chat's taken messages back to waiting with a new place in the waiting order (their runner went away before
     * answering) - except those taken by {@code keepTaker}. Returns how many.
     */
    int requeue(ChatKey chat, String keepTaker);

    /** Puts one taken message back to waiting, as {@link #requeue(ChatKey, String)}. */
    boolean requeue(long id);

    /**
     * Swaps a message's state only when it still has {@code expected} - two runners taking one message, or a take racing a
     * cancel, leave exactly one winner. Returns whether this call changed it.
     */
    boolean changeState(long id, ChatMessage.State expected, ChatMessage.State next);

    /**
     * The newest {@code limit} messages before {@code beforeId} (all when null), oldest first; for a project chat also the
     * messages its cycles were asked from it (the bridge - one record, two views).
     */
    List<ChatMessage> page(ChatKey chat, Long beforeId, int limit);

    /** Messages after {@code afterId}, oldest first, at most {@code limit} - what a new session is handed after a summary. */
    List<ChatMessage> after(ChatKey chat, long afterId, int limit);

    /** Replaces a message's text only while it still waits (a take in between wins). */
    boolean editWaiting(long id, String text, java.time.Instant at);

    /** The oldest user message of a chat still waiting or being answered - a summary never folds it. */
    Optional<Long> firstInFlight(ChatKey chat);

    /** A chat's tasks (compact, refresh, explain more ...) still waiting or taken, oldest first. */
    List<ChatMessage> openTasks(ChatKey chat);

    /** The user's messages still waiting in this chat, urgent ones first, then oldest first. */
    List<ChatMessage> waiting(ChatKey chat);

    /**
     * Ids of the messages whose text contains {@code query} (case-insensitive), newest first, at most {@code limit};
     * {@code filter} is one of mine / claude / decisions / questions / summaries, or empty for all.
     */
    List<Long> search(ChatKey chat, String query, String filter, int limit);

    /** The newest summary of a chat, if it was ever compacted. */
    Optional<ChatMessage> lastSummary(ChatKey chat);

    /** How many messages a chat gained after {@code afterId} (summaries and system lines not counted). */
    int countAfter(ChatKey chat, long afterId);

    /** Whether a message of the chat has this origin (one Alfred suggestion per item, specs/027). */
    default boolean hasOrigin(ChatKey chat, String origin) {
        return page(chat, null, 1000).stream().anyMatch(m -> origin.equals(m.origin()));
    }

    /** One row per chat of the project that has a message (the bar adds the chats without one). */
    List<ChatSummary> summaries(String project);

    /** Waiting user messages and tasks after place {@code afterSeq} in the waiting order, for Claude to take (board_changes / board_wait). */
    List<ChatChange> changesAfter(long afterSeq, String project, String cycleId, int limit);

    long lastMessageId();

    ChatSettings settings(ChatKey chat);

    void putSettings(ChatSettings settings);

    Optional<ChatSession> session(ChatKey chat);

    void putSession(ChatSession session);

    ChatRecord insertRecord(ChatRecord record);

    Optional<ChatRecord> findRecord(long id);

    void markRecordUndone(long id);

    List<ChatRecord> recordsOf(Collection<Long> messageIds);

    TerminalItem insertTerminalItem(TerminalItem item);

    Optional<TerminalItem> findTerminalItem(long id);

    void setTerminalState(Collection<Long> ids, TerminalItem.State state);

    /** A chat's items for the terminal, newest last; {@code openOnly} keeps those not read or taken back. */
    List<TerminalItem> terminalItems(ChatKey chat, boolean openOnly, int limit);

    ChatWatch insertWatch(ChatWatch watch);

    /** The watches of a project (every chat of it), oldest first. */
    List<ChatWatch> watches(String project);

    boolean deleteWatch(long id);

    /** The watches set in one cycle's chat. */
    List<ChatWatch> watchesOfCycle(String cycleId);

    /** The project's chats with "watch while I test" on (FR-030). */
    List<ChatKey> watching(String project);

    /** Every chat row of a removed cycle: messages, records, terminal items, watches, settings, session. */
    void cycleRemoved(String cycleId);

    /**
     * Board export (specs/022 FR-012): the project's messages oldest first, page by page - every chat of the project, or
     * one cycle's chat when {@code cycleId} is given.
     */
    List<ChatMessage> exportPage(String project, String cycleId, long afterId, int limit);

    /** The terminal items these messages sent (board export). */
    List<TerminalItem> terminalOf(Collection<Long> messageIds);
}
