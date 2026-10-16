package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.ChatRunnerEventsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.application.port.out.CycleNamesPort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.Author;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.Kind;
import com.fathy.alfred.backend.board.domain.model.ChatMessage.State;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSession;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatSummary;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.TerminalItem;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * The board chats (specs/022). A user's message waits; the runner holding the chat takes it (one winner), answers it
 * once and records what another session needs. Every change signals {@code chat-changed} and wakes {@code board_wait}
 * through the board's change feed - nothing polls.
 *
 * <p>Who answers: a cycle's chat is the chat (runner) holding that cycle ({@link LiveWorkUseCase#cycleChat}); the project
 * chat is the project's live runner. A cycle's runner never takes a project message, and the reverse.
 */
@Service
public class ChatService implements ChatUseCase, ChatRunnerEventsUseCase {

    /** Bound on what a thread or a handover hands over in one piece. */
    static final int MAX_THREAD = 200;
    static final String COMPACT = "compact";
    /** A batch of calls to check while the user tests (FR-030), queued by ChatWatchService. */
    static final String WATCH = "watch";
    /** The most a reply's payload (questions, proposals, visuals) holds, serialized. */
    static final int MAX_EXTRA = 256 * 1024;
    static final String REFRESH = "refresh";

    private final ChatStorePort chats;
    private final BoardStorePort store;
    private final BoardNotificationPort notifications;
    private final MentionedCallsChangedPort mentionedCalls;
    private final LiveWorkUseCase live;
    private final ChatRecordService records;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public ChatService(ChatStorePort chats, BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                       LiveWorkUseCase live, ChatRecordService records, BoardChangeFeed feed, ObjectMapper json) {
        this(chats, store, notifications, mentionedCalls, live, records, feed, json, Clock.systemUTC());
    }

    ChatService(ChatStorePort chats, BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                LiveWorkUseCase live, ChatRecordService records, BoardChangeFeed feed, ObjectMapper json, Clock clock) {
        this.chats = chats;
        this.store = store;
        this.notifications = feed.feeding(notifications);
        this.mentionedCalls = mentionedCalls;
        this.live = live;
        this.records = records;
        this.json = json;
        this.clock = clock;
    }

    private CycleNamesPort cycleNames;

    /** Cycle names for the board export (specs/022 T052); absent in slice tests. */
    @Autowired(required = false)
    void setCycleNames(CycleNamesPort cycleNames) {
        this.cycleNames = cycleNames;
    }

    @Override
    public ExportPage exportChats(String project, String cycleId, long after, int limit) {
        ChatTransfer.Page page = new ChatTransfer(chats, cycleNames).export(project == null ? "" : project.strip(), cycleId, after, limit);
        return new ExportPage(page.lines(), page.next(), page.more());
    }

    // ------------------------------------------------------------------------------------------------------------ reads

    @Override
    public List<Row> chats(String project) {
        String p = project == null ? "" : project;
        Map<String, ChatSummary> byScope = new LinkedHashMap<>();
        byScope.put(ChatKey.PROJECT_SCOPE, new ChatSummary(p, ChatKey.PROJECT_SCOPE, ChatKey.PROJECT_SCOPE, false, null, null, "", null, 0, 0, 0, 0));
        for (ChatSummary s : chats.summaries(p)) {
            byScope.put(s.scope(), s);
        }
        Set<String> typing = new HashSet<>();
        for (LiveWork w : live.current(p)) {
            if (!w.ended() && w.chatMessageId() != null) {
                chats.find(w.chatMessageId()).ifPresent(m -> typing.add(m.chat().scope()));
            }
        }
        List<Row> out = new ArrayList<>();
        for (ChatSummary s : byScope.values()) {
            ChatKey key = ChatKey.of(p, s.scope());
            out.add(new Row(s, claudeOn(key), typing.contains(s.scope()), chats.session(key).orElse(null)));
        }
        return out;
    }

    /** Whether the Claude that answers this chat is running now. */
    boolean claudeOn(ChatKey chat) {
        return chat.isProject() ? live.runner(chat.project(), LiveWorkUseCase.KIND_LIVE).isPresent()
                : live.cycleChat(chat.cycleId()).filter(c -> c.project().equals(chat.project())).isPresent();
    }

    @Override
    public Page page(ChatKey chat, Long before, int limit) {
        int n = limit <= 0 ? DEFAULT_PAGE : Math.min(limit, MAX_PAGE);
        List<ChatMessage> messages = chats.page(chat, before, n + 1);
        boolean more = messages.size() > n;
        if (more) {
            messages = messages.subList(1, messages.size());
        }
        Map<Long, List<ChatRecord>> recs = new HashMap<>();
        for (ChatRecord r : chats.recordsOf(messages.stream().filter(m -> m.author() == Author.CLAUDE).map(ChatMessage::id).toList())) {
            recs.computeIfAbsent(r.messageId(), k -> new ArrayList<>()).add(r);
        }
        return new Page(messages, more, recs);
    }

    @Override
    public Optional<ChatMessage> message(long id) {
        return chats.find(id);
    }

    @Override
    public Optional<ChatMessage> answerOf(long id) {
        ChatMessage q = chats.find(id).orElse(null);
        if (q == null) {
            return Optional.empty();
        }
        return chats.after(q.chat(), q.id(), MAX_THREAD).stream()
                .filter(m -> m.author() == Author.CLAUDE && Objects.equals(m.replyTo(), q.id()) && !m.superseded())
                .reduce((a, b) -> b);
    }

    @Override
    public List<Hit> search(ChatKey chat, String query, String filter) {
        String q = query == null ? "" : query.strip();
        if (q.length() > MAX_QUERY) {
            q = q.substring(0, MAX_QUERY);
        }
        long covers = chats.lastSummary(chat).map(s -> s.coversTo() == null ? 0L : s.coversTo()).orElse(0L);
        List<Hit> out = new ArrayList<>();
        for (long id : chats.search(chat, q, filter, MAX_SEARCH)) {
            chats.find(id).ifPresent(m -> out.add(new Hit(m.id(), m.parentId(), m.kind() != Kind.SUMMARY && m.id() <= covers)));
        }
        return out;
    }

    @Override
    public ChatSettings settings(ChatKey chat) {
        return chats.settings(chat);
    }

    @Override
    public List<TerminalItem> terminal(ChatKey chat) {
        return chats.terminalItems(chat, false, 200);
    }

    @Override
    public Handover handover(ChatKey chat) {
        ChatMessage summary = chats.lastSummary(chat).orElse(null);
        List<ChatMessage> after = chats.after(chat, summary == null ? 0 : summary.id(), MAX_THREAD);
        List<ChatMessage> decisions = new ArrayList<>();
        for (long id : chats.search(chat, "", "decisions", 50)) {
            chats.find(id).ifPresent(decisions::add);
        }
        decisions.sort((a, b) -> Long.compare(a.id(), b.id()));
        return new Handover(summary, after, decisions, chats.terminalItems(chat, true, 50), chats.session(chat).orElse(null));
    }

    // ----------------------------------------------------------------------------------------------------- user writes

    @Override
    public Result<ChatMessage> post(Actor actor, ChatKey chat, Post post) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Claude answers with a reply to the message it took, not a new message");
        }
        String text = clean(post.text());
        boolean images = post.imageIds() != null && !post.imageIds().isEmpty();
        if (text.isBlank() && !images) {
            return Result.no(Outcome.INVALID, "Write something to send");
        }
        if (text.length() > ChatMessage.MAX_TEXT) {
            return Result.no(Outcome.INVALID, "A chat message holds at most 64 KB");
        }
        // FR-035: the project chat asks a cycle's Claude - the message lives in the cycle's chat, shown in both.
        String bridgeFrom = null;
        String origin = origin(post.origin());
        if (origin.startsWith("bridge:")) {
            String cycleId = origin.substring(7).strip();
            if (!chat.isProject() || !cycleId.matches("^[A-Za-z0-9-]{1,64}$")) {
                return Result.no(Outcome.INVALID, "Only the project chat asks a cycle's Claude, and it names the cycle");
            }
            if (post.parentId() != null) {
                return Result.no(Outcome.INVALID, "A question for a cycle starts its own thread");
            }
            chat = new ChatKey(chat.project(), cycleId);
            bridgeFrom = "project";
            origin = "bridge";
        }
        if (post.parentId() != null) {
            ChatMessage parent = chats.find(post.parentId()).orElse(null);
            if (parent == null || !parent.chat().equals(chat)) {
                return Result.no(Outcome.INVALID, "A reply goes in a thread of the same chat");
            }
        }
        List<String> context = post.context() == null ? List.of() : post.context().stream().limit(10).map(MentionParser::serialize).toList();
        String quote = post.quote() == null || post.quote().isBlank() ? null : cut(post.quote().strip(), 4000);
        ChatMessage stored = chats.insert(new ChatMessage(0, chat, post.parentId(), Author.USER, Kind.TEXT, text, State.WAITING, post.urgent(),
                false, origin, context, quote, null, Map.of(), null, null, bridgeFrom, false, clock.instant(), null));
        indexMentions(stored);
        if (images) {
            store.attachImages(new HashSet<>(post.imageIds()), null, chat.isProject() ? null : chat.cycleId());
        }
        store.attachImages(RichText.imageIds(text), null, chat.isProject() ? null : chat.cycleId());
        autoCompact(chat);
        changed(chat, stored.id());
        if (bridgeFrom != null) {
            notifications.chatChanged(chat.project(), ChatKey.PROJECT_SCOPE, stored.id());
        }
        return Result.ok(stored);
    }

    @Override
    public Result<ChatMessage> edit(Actor actor, long id, String text) {
        Result<ChatMessage> own = ownWaiting(actor, id, "edit");
        if (!own.isOk()) {
            return own;
        }
        String clean = clean(text);
        if (clean.isBlank() || clean.length() > ChatMessage.MAX_TEXT) {
            return Result.no(Outcome.INVALID, clean.isBlank() ? "Write something to send" : "A chat message holds at most 64 KB");
        }
        // Claude may take it between the read and the write: the text then stays as Claude read it.
        if (!chats.editWaiting(id, clean, clock.instant())) {
            return Result.no(Outcome.CONFLICT, "Claude took it just now - it reads the text as it was");
        }
        ChatMessage now = chats.find(id).orElseThrow();
        indexMentions(now);
        changed(now.chat(), id);
        return Result.ok(now);
    }

    @Override
    public Result<ChatMessage> cancel(Actor actor, long id) {
        Result<ChatMessage> own = ownWaiting(actor, id, "cancel");
        if (!own.isOk()) {
            return own;
        }
        if (!chats.changeState(id, State.WAITING, State.CANCELLED)) {
            return Result.no(Outcome.CONFLICT, "Claude took it just now - it can no longer be cancelled; press Stop instead");
        }
        changed(own.value().chat(), id);
        return Result.ok(chats.find(id).orElseThrow());
    }

    @Override
    public Result<ChatMessage> urgent(Actor actor, long id) {
        Result<ChatMessage> own = ownWaiting(actor, id, "put first");
        if (!own.isOk()) {
            return own;
        }
        ChatMessage m = own.value();
        chats.update(new ChatMessage(m.id(), m.chat(), m.parentId(), m.author(), m.kind(), m.text(), m.state(), true, m.decision(), m.origin(),
                m.context(), m.quote(), m.extra(), m.reactions(), m.coversTo(), m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(),
                m.editedAt()));
        changed(m.chat(), id);
        return Result.ok(chats.find(id).orElseThrow());
    }

    @Override
    public Result<ChatMessage> compact(Actor actor, ChatKey chat) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Write the summary with chat_summary");
        }
        Optional<ChatMessage> open = openTask(chat, COMPACT);
        if (open.isPresent()) {
            return Result.ok(open.get());
        }
        long last = lastTalkId(chat);
        if (last == 0 || chats.countAfter(chat, chats.lastSummary(chat).map(ChatMessage::id).orElse(0L)) == 0) {
            return Result.no(Outcome.INVALID, "Nothing new to compact since the last summary");
        }
        ChatMessage task = task(chat, COMPACT, "Compact this chat: write a summary of everything up to #" + last
                + " - decisions, findings, open questions as chips. Nothing is deleted.");
        changed(chat, task.id());
        return Result.ok(task);
    }

    @Override
    public Result<ChatSettings> putSettings(Actor actor, ChatSettings settings) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "A chat's settings are the user's");
        }
        chats.putSettings(settings);
        changed(settings.chat(), null);
        return Result.ok(settings);
    }

    @Override
    public Result<Void> undoRecord(Actor actor, long recordId) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Undo is the user's");
        }
        ChatRecord r = chats.findRecord(recordId).orElse(null);
        if (r == null) {
            return Result.no(Outcome.NOT_FOUND, "No such record");
        }
        if (r.undone()) {
            return Result.no(Outcome.CONFLICT, "Already undone");
        }
        String why = records.undo(r);
        if (why != null) {
            return Result.no(Outcome.CONFLICT, why);
        }
        chats.markRecordUndone(recordId);
        ChatMessage answer = chats.find(r.messageId()).orElse(null);
        if (answer != null && r.kind() == ChatRecord.Kind.ITEM && r.undo() != null) {
            try {
                String proposal = json.readTree(r.undo()).path("proposal").asText();
                chats.update(withExtra(answer, records.withoutProposal(answer.extra(), proposal)));
            } catch (Exception e) {
                // the record is undone either way; a payload that cannot be read keeps its proposal
            }
        }
        if (answer != null) {
            changed(answer.chat(), answer.id());
        }
        return Result.ok(null);
    }

    @Override
    public Result<Void> undoTerminal(Actor actor, long itemId) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Undo is the user's");
        }
        TerminalItem item = chats.findTerminalItem(itemId).orElse(null);
        if (item == null) {
            return Result.no(Outcome.NOT_FOUND, "No such item");
        }
        if (!item.canUndo()) {
            return Result.no(Outcome.CONFLICT, item.state() == TerminalItem.State.READ ? "The terminal already read it" : "Already taken back");
        }
        chats.setTerminalState(List.of(itemId), TerminalItem.State.UNDONE);
        changed(item.chat(), item.messageId());
        return Result.ok(null);
    }

    @Override
    public Result<Void> refresh(Actor actor, ChatKey chat) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Refresh is the user's");
        }
        if (chat.isProject()) {
            return Result.no(Outcome.INVALID, "The project chat has no terminal session to copy");
        }
        if (openTask(chat, REFRESH).isEmpty()) {
            ChatMessage task = task(chat, REFRESH, "Refresh from the terminal session: copy it again before the next answer.");
            changed(chat, task.id());
        }
        return Result.ok(null);
    }

    // -------------------------------------------------------------------------------------------------- Claude's writes

    // ------------------------------------------------------------------------------------- decisions, reactions, again

    @Override
    public Result<ChatMessage> decision(Actor actor, long id, boolean on) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "★ is the user's - Claude records a decision with its answer");
        }
        ChatMessage m = chats.find(id).orElse(null);
        if (m == null || m.kind() != ChatMessage.Kind.TEXT) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        if (m.decision() == on) {
            return Result.ok(m);
        }
        if (on) {
            ChatRecordService.Applied applied = records.apply(m, new RecordRequest(ChatRecord.Kind.DECISION, cut(RichText.plain(m.text()), 500),
                    null, null, null));
            if (applied.record() == null) {
                return Result.no(Outcome.CONFLICT, applied.refused());
            }
            chats.insertRecord(applied.record());
        } else {
            for (ChatRecord r : chats.recordsOf(List.of(id))) {
                if (r.kind() == ChatRecord.Kind.DECISION && !r.undone()) {
                    String why = records.undo(r);
                    if (why != null) {
                        return Result.no(Outcome.CONFLICT, why);
                    }
                    chats.markRecordUndone(r.id());
                }
            }
        }
        ChatMessage next = withDecision(m, on);
        chats.update(next);
        changed(m.chat(), id);
        return Result.ok(next);
    }

    @Override
    public Result<ChatMessage> react(Actor actor, long id, String emoji) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Reactions are the user's");
        }
        if (emoji == null || !REACTIONS.contains(emoji)) {
            return Result.no(Outcome.INVALID, "A reaction is one of " + String.join(" ", new java.util.TreeSet<>(REACTIONS)));
        }
        ChatMessage m = chats.find(id).orElse(null);
        if (m == null) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        Map<String, Integer> reactions = new LinkedHashMap<>(m.reactions());
        boolean added = reactions.remove(emoji) == null;
        if (added) {
            reactions.put(emoji, 1);
        }
        ChatMessage next = new ChatMessage(m.id(), m.chat(), m.parentId(), m.author(), m.kind(), m.text(), m.state(), m.urgent(), m.decision(),
                m.origin(), m.context(), m.quote(), m.extra(), reactions, m.coversTo(), m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(),
                m.editedAt());
        chats.update(next);
        if (added && "❓".equals(emoji) && m.author() == Author.CLAUDE) {
            // FR-044: an ordinary waiting question in the answer's thread - the queue, take and reply do the rest.
            chats.insert(new ChatMessage(0, m.chat(), m.parentId() == null ? m.id() : m.parentId(), Author.USER, ChatMessage.Kind.TEXT,
                    "❓ Explain more: your answer #" + m.id() + " was not clear enough - explain it in more detail, step by step.",
                    State.WAITING, false, false, "explain", List.of(), null, null, Map.of(), null, null, null, false, clock.instant(), null));
        }
        changed(m.chat(), id);
        return Result.ok(next);
    }

    @Override
    public Result<ChatMessage> answer(Actor actor, long answerId, Map<String, String> answers) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Answers are the user's");
        }
        ChatMessage m = chats.find(answerId).orElse(null);
        if (m == null || m.author() != Author.CLAUDE || m.extra() == null || !m.extra().path("questions").isArray()) {
            return Result.no(Outcome.NOT_FOUND, "Message " + answerId + " asks no questions");
        }
        if (answers == null || answers.isEmpty()) {
            return Result.no(Outcome.INVALID, "Answer at least one question");
        }
        ObjectNode extra = ((ObjectNode) m.extra()).deepCopy();
        List<String> lines = new ArrayList<>();
        for (JsonNode q : extra.path("questions")) {
            String header = q.path("header").asText("");
            String a = answers.get(header);
            if (a == null || a.isBlank() || q.hasNonNull("answer") || !q.isObject()) {
                continue;
            }
            String text = cut(a.strip(), 2000);
            ((ObjectNode) q).put("answer", text).put("answeredAt", clock.instant().toString());
            lines.add("- **" + header + "**: " + text);
        }
        if (lines.isEmpty()) {
            return Result.no(Outcome.CONFLICT, "Those questions are answered already, or none of them was asked here");
        }
        chats.update(withExtra(m, extra));
        ChatMessage sent = chats.insert(new ChatMessage(0, m.chat(), m.parentId() == null ? m.id() : m.parentId(), Author.USER,
                ChatMessage.Kind.TEXT, "Answers to your questions in #" + m.id() + ":\n" + String.join("\n", lines), State.WAITING, false, false,
                "answers", List.of(), null, null, Map.of(), null, null, null, false, clock.instant(), null));
        changed(m.chat(), sent.id());
        return Result.ok(sent);
    }

    @Override
    public Result<ChatMessage> again(Actor actor, long answerId, AskAgain ask) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Asking again is the user's");
        }
        ChatMessage answer = chats.find(answerId).orElse(null);
        if (answer == null || answer.author() != Author.CLAUDE || answer.replyTo() == null) {
            return Result.no(Outcome.NOT_FOUND, "Ask again works on Claude's answer");
        }
        if (answer.superseded()) {
            return Result.no(Outcome.CONFLICT, "Already asked again");
        }
        ChatMessage question = chats.find(answer.replyTo()).orElse(null);
        if (question == null) {
            return Result.no(Outcome.NOT_FOUND, "The question of answer " + answerId + " is gone");
        }
        String extra = ask == null || ask.text() == null ? "" : clean(ask.text());
        if (extra.length() > 4000) {
            return Result.no(Outcome.INVALID, "What you add holds at most 4000 characters");
        }
        List<String> read = new ArrayList<>();
        if (ask != null && ask.logs()) {
            read.add("the log lines of the calls involved (call_logs)");
        }
        if (ask != null && ask.sql()) {
            read.add("the SQL they ran (db_statements)");
        }
        if (ask != null && ask.items()) {
            read.add("the acceptance items (board_requirements)");
        }
        StringBuilder text = new StringBuilder("↻ Asked again - your answer #").append(answerId).append(" was not enough.\n\n")
                .append(RichText.plain(question.text()).strip());
        if (!read.isEmpty()) {
            text.append("\n\nThis time read ").append(String.join(", ", read)).append(" before answering.");
        }
        if (!extra.isBlank()) {
            text.append("\n\n").append(extra);
        }
        if (text.length() > ChatMessage.MAX_TEXT) {
            return Result.no(Outcome.INVALID, "The question is too long to ask again - write it anew");
        }
        chats.update(new ChatMessage(answer.id(), answer.chat(), answer.parentId(), answer.author(), answer.kind(), answer.text(), answer.state(),
                answer.urgent(), answer.decision(), answer.origin(), answer.context(), answer.quote(), answer.extra(), answer.reactions(),
                answer.coversTo(), answer.replyTo(), answer.bridgeFrom(), true, answer.createdAt(), answer.editedAt()));
        ChatMessage asked = chats.insert(new ChatMessage(0, question.chat(), question.parentId(), Author.USER, ChatMessage.Kind.TEXT,
                text.toString(), State.WAITING, false, false, "asked-again", question.context(), null, null, Map.of(), null, null, null, false,
                clock.instant(), null));
        indexMentions(asked);
        changed(question.chat(), asked.id());
        return Result.ok(asked);
    }

    @Override
    public List<SharedGroup> shared(ChatKey chat) {
        Map<String, Map<String, SharedRef>> byType = new java.util.TreeMap<>();
        long after = 0;
        for (int pages = 0; pages < 200; pages++) {
            List<ChatMessage> page = chats.after(chat, after, 500);
            for (ChatMessage m : page) {
                List<MentionRef> refs = new ArrayList<>(MentionParser.mentions(RichText.plain(m.text())));
                for (String c : m.context()) {
                    refs.addAll(MentionParser.mentions(c));
                }
                for (MentionRef r : refs) {
                    String type = r.type().name().toLowerCase(java.util.Locale.ROOT);
                    byType.computeIfAbsent(type, k -> new LinkedHashMap<>()).putIfAbsent(r.ref(), new SharedRef(
                            Map.of("type", type, "ref", r.ref(), "label", r.label() == null ? "" : r.label()), m.id(), m.createdAt()));
                }
                after = m.id();
            }
            if (page.size() < 500) {
                break;
            }
        }
        List<SharedGroup> out = new ArrayList<>();
        byType.forEach((type, refs) -> out.add(new SharedGroup(type, List.copyOf(refs.values()))));
        return out;
    }

    @Override
    public Optional<Digest> digest(ChatKey chat, Instant since) {
        if (since == null) {
            return Optional.empty();
        }
        String cycleId = chat.isProject() ? null : chat.cycleId();
        List<BoardChanges.Entry> entries = store.activityAfter(store.activityIdBefore(since), chat.project(), cycleId, null, 501);
        List<BoardChanges.CycleChange> cycles = cycleId == null ? List.of() : store.cycleChangesAfter(since.toEpochMilli(), chat.project(), cycleId, 201);
        List<String> lines = ChatDigest.lines(entries, cycles);
        return lines.isEmpty() ? Optional.empty() : Optional.of(new Digest(lines, since));
    }

    private static ChatMessage withDecision(ChatMessage m, boolean on) {
        return new ChatMessage(m.id(), m.chat(), m.parentId(), m.author(), m.kind(), m.text(), m.state(), m.urgent(), on, m.origin(), m.context(),
                m.quote(), m.extra(), m.reactions(), m.coversTo(), m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(), m.editedAt());
    }

    @Override
    public Result<Taken> take(Actor actor, long id, String chatId, String cycleId) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only Claude takes a chat message");
        }
        ChatMessage m = chats.find(id).orElse(null);
        if (m == null) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        String runnerCycle = cycleId == null || cycleId.isBlank() ? null : cycleId.strip();
        if (m.chat().isProject()) {
            if (runnerCycle != null) {
                return Result.no(Outcome.CONFLICT, "The project chat is answered by the project's live runner, not a cycle's chat");
            }
            if (live.runner(m.chat().project(), LiveWorkUseCase.KIND_LIVE).isEmpty()) {
                return Result.no(Outcome.CONFLICT, "No live runner answers this project - start /alfred-live for it");
            }
        } else {
            if (runnerCycle == null || !runnerCycle.equals(m.chat().cycleId())) {
                return Result.no(Outcome.CONFLICT, "This message is in the chat of cycle " + m.chat().cycleId() + " - its own chat answers it");
            }
            Optional<LiveWorkUseCase.CycleChat> holder = live.cycleChat(m.chat().cycleId());
            if (holder.isPresent() && !holder.get().chatId().equals(chatId)) {
                return Result.no(Outcome.CONFLICT, "Another chat (" + holder.get().chatId() + " on " + holder.get().host() + ") holds this cycle");
            }
        }
        if (!chats.take(id, chatId, clock.instant())) {
            return Result.no(Outcome.CONFLICT, "Message " + id + " is " + chats.find(id).map(x -> x.state().name().toLowerCase()).orElse("gone"));
        }
        ChatMessage taken = chats.find(id).orElseThrow();
        changed(taken.chat(), id);
        return Result.ok(new Taken(taken, thread(taken), chats.lastSummary(taken.chat()).orElse(null)));
    }

    private List<ChatMessage> thread(ChatMessage m) {
        if (m.parentId() == null) {
            return List.of();
        }
        List<ChatMessage> out = new ArrayList<>();
        chats.find(m.parentId()).ifPresent(out::add);
        chats.after(m.chat(), m.parentId(), MAX_THREAD).stream()
                .filter(x -> Objects.equals(x.parentId(), m.parentId()) && x.id() != m.id()).forEach(out::add);
        return out;
    }

    @Override
    public Result<Replied> reply(Actor actor, long id, Reply reply) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only Claude answers a chat message");
        }
        ChatMessage q = chats.find(id).orElse(null);
        if (q == null) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        String text = clean(reply.text());
        if (text.isBlank() || text.length() > ChatMessage.MAX_TEXT) {
            return Result.no(Outcome.INVALID, text.isBlank() ? "An answer needs text" : "An answer holds at most 64 KB");
        }
        if (reply.extra() != null && reply.extra().toString().length() > MAX_EXTRA) {
            return Result.no(Outcome.INVALID, "Questions, proposals and visuals hold at most 256 KB - send a bulky part as a reference");
        }
        if (reply.updateId() != null) {
            ChatMessage before = chats.find(reply.updateId()).orElse(null);
            if (before == null || before.author() != Author.CLAUDE || !Objects.equals(before.replyTo(), id)) {
                return Result.no(Outcome.INVALID, "updateId must be your earlier answer to message " + id);
            }
            ChatMessage updated = new ChatMessage(before.id(), before.chat(), before.parentId(), before.author(), before.kind(), text, before.state(),
                    before.urgent(), before.decision(), before.origin(), before.context(), before.quote(),
                    reply.extra() == null ? before.extra() : reply.extra(), before.reactions(), before.coversTo(), before.replyTo(),
                    before.bridgeFrom(), before.superseded(), before.createdAt(), clock.instant());
            chats.update(updated);
            indexMentions(updated);
            changed(q.chat(), updated.id());
            return Result.ok(new Replied(chats.find(updated.id()).orElseThrow(), List.of(), List.of()));
        }
        if (q.state() != State.TAKEN) {
            return Result.no(Outcome.CONFLICT, "Take the message first (it is " + q.state().name().toLowerCase() + ")");
        }
        if (q.kind() == Kind.TASK && WATCH.equals(q.origin()) && reply.extra() != null && reply.extra().path("quiet").asBoolean(false)) {
            // FR-030: a watched batch with no findings posts nothing - the task is done, the chat stays quiet.
            chats.changeState(q.id(), State.TAKEN, State.ANSWERED);
            changed(q.chat(), q.id());
            return Result.ok(new Replied(chats.find(q.id()).orElseThrow(), List.of(), List.of()));
        }
        ChatMessage answer = chats.insert(new ChatMessage(0, q.chat(), q.parentId(), Author.CLAUDE, Kind.TEXT, text, State.DONE, false, false,
                null, List.of(), null, reply.extra(), Map.of(), null, q.id(), q.bridgeFrom(), false, clock.instant(), null));
        chats.changeState(q.id(), State.TAKEN, State.ANSWERED);
        indexMentions(answer);

        List<ChatRecord> stored = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        List<JsonNode> proposals = new ArrayList<>();
        for (RecordRequest r : reply.records() == null ? List.<RecordRequest>of() : reply.records()) {
            ChatRecordService.Applied applied = records.apply(answer, r);
            if (applied.record() == null) {
                refused.add((r == null || r.kind() == null ? "record" : r.kind().name().toLowerCase()) + ": " + applied.refused());
                continue;
            }
            stored.add(chats.insertRecord(applied.record()));
            if (applied.proposal() != null) {
                proposals.add(applied.proposal());
            }
        }
        if (!proposals.isEmpty()) {
            ObjectNode extra = answer.extra() != null && answer.extra().isObject() ? ((ObjectNode) answer.extra()).deepCopy() : json.createObjectNode();
            ArrayNode list = extra.path("proposals").isArray() ? (ArrayNode) extra.get("proposals") : extra.putArray("proposals");
            proposals.forEach(list::add);
            chats.update(withExtra(answer, extra));
        }
        if (!refused.isEmpty()) {
            system(q.chat(), q.parentId(), "Claude could not record: " + String.join("; ", refused));
        }
        List<TerminalItem> items = new ArrayList<>();
        if (!q.chat().isProject() && reply.toTerminal() != null) {
            TerminalItem.State state = terminalState(q.chat());
            for (ToTerminal t : reply.toTerminal()) {
                if (t == null || t.text() == null || t.text().isBlank()) {
                    continue;
                }
                items.add(chats.insertTerminalItem(new TerminalItem(0, q.chat(), q.id(), t.urgent(), t.mirror(), t.text(), reason(t.reason()), state,
                        null, null, null)));
            }
        }
        changed(q.chat(), answer.id());
        return Result.ok(new Replied(chats.find(answer.id()).orElseThrow(), stored, items));
    }

    @Override
    public Result<ChatMessage> summary(Actor actor, ChatKey chat, String text, long coversTo) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Claude writes a chat's summary (press ⇊ to ask for one)");
        }
        String clean = clean(text);
        if (clean.isBlank() || clean.length() > ChatMessage.MAX_TEXT) {
            return Result.no(Outcome.INVALID, "A summary needs text, at most 64 KB");
        }
        long covers = Math.min(coversTo, lastTalkId(chat));
        // never fold a message still waiting or being answered
        Optional<Long> inFlight = chats.firstInFlight(chat);
        if (inFlight.isPresent()) {
            covers = Math.min(covers, inFlight.get() - 1);
        }
        long previous = chats.lastSummary(chat).map(s -> s.coversTo() == null ? 0L : s.coversTo()).orElse(0L);
        if (covers <= previous) {
            return Result.no(Outcome.INVALID, "Nothing new to cover: the last summary already covers up to #" + previous);
        }
        ChatMessage stored = chats.insert(new ChatMessage(0, chat, null, Author.CLAUDE, Kind.SUMMARY, clean, State.DONE, false, false, COMPACT,
                List.of(), null, null, Map.of(), covers, null, null, false, clock.instant(), null));
        indexMentions(stored);
        for (ChatMessage t : chats.openTasks(chat)) {
            if (COMPACT.equals(t.origin())) {
                chats.update(t.withState(State.ANSWERED));
            }
        }
        if (!chat.isProject()) {
            chats.insertTerminalItem(new TerminalItem(0, chat, stored.id(), false, false, "💬 board chat compacted: summary #" + stored.id()
                    + " covers up to #" + covers + " - chat_read {\"project\":\"" + chat.project() + "\",\"scope\":\"" + chat.scope() + "\",\"id\":"
                    + stored.id() + "}", "compact", terminalState(chat), null, null, null));
        }
        changed(chat, stored.id());
        return Result.ok(stored);
    }

    @Override
    public Result<ChatSession> putSession(Actor actor, ChatKey chat, String chatSessionId, String forkedFrom, String host, Instant forkedAt,
                                          Instant seenUpTo) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "The runner keeps the chat's session");
        }
        ChatSession was = chats.session(chat).orElse(null);
        // The same session caught up (FR-052): it keeps where it was copied from, and what it has seen never moves back.
        boolean same = was != null && java.util.Objects.equals(was.chatSessionId(), chatSessionId);
        if (same && forkedFrom == null && forkedAt == null) {
            forkedFrom = was.forkedFrom();
            forkedAt = was.forkedAt();
            if (was.seenUpTo() != null && (seenUpTo == null || seenUpTo.isBefore(was.seenUpTo()))) {
                seenUpTo = was.seenUpTo();
            }
        }
        ChatSession next = new ChatSession(chat, chatSessionId, forkedFrom, host, forkedAt, seenUpTo, was == null ? null : was.terminalAt());
        chats.putSession(next);
        if (tookOver(was, next)) {
            // FR-016: another conversation answers from now on - it was handed the summary and the messages after it.
            system(chat, null, next.answeredByTerminal()
                    ? "↻ Your terminal session answers this chat now" + (next.host() == null ? "" : " (on " + next.host() + ")")
                    + " - the session itself, no copy; it reads the summary and the recent messages when it needs them."
                    : "↻ A new Claude conversation answers this chat now" + (next.host() == null ? "" : " (on " + next.host() + ")")
                    + (next.forkedFrom() == null ? " - it started from the latest summary and the messages after it."
                    : " - a copy of that terminal session, handed the latest summary and the messages after it."));
        }
        changed(chat, null);
        return Result.ok(next);
    }

    /** Another machine, or a copy of another terminal session - not the same chat session continued or re-copied (FR-052 says that). */
    static boolean tookOver(ChatSession was, ChatSession next) {
        if (was == null || was.chatSessionId() == null || java.util.Objects.equals(was.chatSessionId(), next.chatSessionId())) {
            return false;
        }
        return !java.util.Objects.equals(was.host(), next.host()) || !java.util.Objects.equals(was.forkedFrom(), next.forkedFrom())
                || next.answeredByTerminal() != was.answeredByTerminal(); // a copy replaced by the terminal session itself
    }

    @Override
    public Result<List<TerminalItem>> addTerminal(Actor actor, ChatKey chat, List<ToTerminal> items) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only the runner sends the terminal items");
        }
        if (chat.isProject()) {
            return Result.no(Outcome.INVALID, "The project chat has no terminal session");
        }
        TerminalItem.State state = terminalState(chat);
        List<TerminalItem> out = new ArrayList<>();
        for (ToTerminal t : items) {
            if (t != null && t.text() != null && !t.text().isBlank()) {
                out.add(chats.insertTerminalItem(new TerminalItem(0, chat, null, t.urgent(), t.mirror(), t.text(), reason(t.reason()), state, null,
                        null, null)));
            }
        }
        changed(chat, null);
        return Result.ok(out);
    }

    @Override
    public Result<Void> delivered(Actor actor, List<Long> ids, boolean read) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only the runner reports delivery");
        }
        if (ids == null || ids.isEmpty()) {
            return Result.ok(null);
        }
        List<Long> some = ids.stream().limit(500).toList();
        chats.setTerminalState(some, read ? TerminalItem.State.READ : TerminalItem.State.DELIVERED);
        chats.findTerminalItem(some.get(0)).ifPresent(t -> changed(t.chat(), null));
        return Result.ok(null);
    }

    @Override
    public Result<ChatMessage> release(Actor actor, long id, boolean failed, String why) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only the runner gives a message back");
        }
        ChatMessage m = chats.find(id).orElse(null);
        if (m == null) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        if (failed) {
            stopTaken(m, why == null || why.isBlank() ? "Claude could not answer" : "Claude could not answer: " + cut(why, 300));
        } else if (chats.requeue(id)) {
            changed(m.chat(), id);
        }
        return Result.ok(chats.find(id).orElseThrow());
    }

    @Override
    public Result<ChatMessage> systemLine(Actor actor, ChatKey chat, String text) {
        if (actor != Actor.CLAUDE) {
            return Result.no(Outcome.INVALID, "Only the runner writes a chat's system lines");
        }
        if (text == null || text.isBlank()) {
            return Result.no(Outcome.INVALID, "A system line needs text");
        }
        ChatMessage line = chats.insert(new ChatMessage(0, chat, null, Author.ALFRED, Kind.SYSTEM, cut(text.strip(), 500), State.DONE, false, false,
                null, List.of(), null, null, Map.of(), null, null, null, false, clock.instant(), null));
        changed(chat, line.id());
        return Result.ok(line);
    }

    @Override
    public Result<ChatWatch> watch(Actor actor, ChatKey chat, ChatWatch.Kind kind, String target, String label, Long messageId) {
        if (kind == null || target == null || target.isBlank() || label == null || label.isBlank()) {
            return Result.no(Outcome.INVALID, "A watch needs its kind, target and label");
        }
        ChatWatch w = chats.insertWatch(new ChatWatch(0, chat, kind, cut(target.strip(), 200), cut(label.strip(), 200), messageId, clock.instant()));
        changed(chat, messageId);
        return Result.ok(w);
    }

    @Override
    public List<ChatWatch> watches(ChatKey chat) {
        return chats.watches(chat.project()).stream().filter(w -> w.chat().equals(chat)).toList();
    }

    @Override
    public Result<Void> cancelWatch(Actor actor, long id) {
        return chats.deleteWatch(id) ? Result.ok(null) : Result.no(Outcome.NOT_FOUND, "No such watch");
    }

    // --------------------------------------------------------------------------------------------------- runner events

    @Override
    public void runnerStarted(String project, String cycleId, String chatId) {
        ChatKey chat = new ChatKey(project, cycleId);
        if (chats.requeue(chat, chatId) > 0) {
            changed(chat, null);
        }
    }

    @Override
    public void runEnded(long messageId, LiveWork.State state, String outcome) {
        if (state == LiveWork.State.WORKING || state == LiveWork.State.DONE) {
            return;
        }
        chats.find(messageId).filter(m -> m.state() == State.TAKEN).ifPresent(m -> stopTaken(m,
                state == LiveWork.State.STOPPED ? "Stopped" : "Claude could not answer" + (outcome == null ? "" : ": " + cut(outcome, 300))));
    }

    private void stopTaken(ChatMessage m, String line) {
        if (chats.changeState(m.id(), State.TAKEN, State.STOPPED)) {
            system(m.chat(), m.parentId(), line + " - ask again to retry.");
            changed(m.chat(), m.id());
        }
    }

    // --------------------------------------------------------------------------------------------------------- helpers

    /** Held for a terminal while no runner holds the cycle; sent when one does (the runner writes it at the terminal's next turn). */
    private TerminalItem.State terminalState(ChatKey chat) {
        return live.cycleChat(chat.cycleId()).isPresent() ? TerminalItem.State.SENT : TerminalItem.State.WAITING;
    }

    private void autoCompact(ChatKey chat) {
        ChatSettings s = chats.settings(chat);
        if (s.autoN() <= 0 || openTask(chat, COMPACT).isPresent()) {
            return;
        }
        long since = chats.lastSummary(chat).map(ChatMessage::id).orElse(0L);
        if (chats.countAfter(chat, since) >= s.autoN()) {
            task(chat, COMPACT, "Auto-compact (" + s.autoN() + " messages since the last summary): write a summary of everything up to #"
                    + lastTalkId(chat) + " - decisions, findings, open questions as chips. Nothing is deleted.");
        }
    }

    private Optional<ChatMessage> openTask(ChatKey chat, String origin) {
        return chats.openTasks(chat).stream().filter(m -> origin.equals(m.origin())).findFirst();
    }

    private ChatMessage task(ChatKey chat, String origin, String text) {
        return chats.insert(new ChatMessage(0, chat, null, Author.ALFRED, Kind.TASK, text, State.WAITING, false, false, origin, List.of(), null,
                null, Map.of(), null, null, null, false, clock.instant(), null));
    }

    private void system(ChatKey chat, Long parentId, String text) {
        chats.insert(new ChatMessage(0, chat, parentId, Author.ALFRED, Kind.SYSTEM, cut(text, 4000), State.DONE, false, false, null, List.of(),
                null, null, Map.of(), null, null, null, false, clock.instant(), null));
    }

    /** The newest message a summary may cover: the last of the talk (not a summary, task or system line). */
    private long lastTalkId(ChatKey chat) {
        List<ChatMessage> newest = chats.page(chat, null, 50);
        for (int i = newest.size() - 1; i >= 0; i--) {
            ChatMessage m = newest.get(i);
            if (m.chat().equals(chat) && (m.kind() == Kind.TEXT || m.kind() == Kind.DIGEST)) {
                return m.id();
            }
        }
        return 0;
    }

    private Result<ChatMessage> ownWaiting(Actor actor, long id, String what) {
        if (actor == Actor.CLAUDE) {
            return Result.no(Outcome.REFUSED_FOR_CLAUDE, "Only the user can " + what + " their message");
        }
        ChatMessage m = chats.find(id).orElse(null);
        if (m == null) {
            return Result.no(Outcome.NOT_FOUND, "No chat message " + id);
        }
        if (m.author() != Author.USER) {
            return Result.no(Outcome.INVALID, "Only your own messages can be changed");
        }
        if (m.state() != State.WAITING) {
            return Result.no(Outcome.CONFLICT, "Only a message still waiting can be changed - it is " + m.state().name().toLowerCase());
        }
        return Result.ok(m);
    }

    private void indexMentions(ChatMessage m) {
        List<MentionRef> refs = MentionParser.mentions(RichText.plain(m.text()));
        List<MentionRef> before = store.mentionsOf(MentionOwner.CHAT, String.valueOf(m.id())).stream().map(x -> x.ref()).toList();
        if (refs.isEmpty() && before.isEmpty()) {
            return;
        }
        store.replaceMentions(MentionOwner.CHAT, String.valueOf(m.id()), null, refs);
        if (refs.stream().anyMatch(r -> r.liveCallId() != null) || before.stream().anyMatch(r -> r.liveCallId() != null)) {
            mentionedCalls.mentionedCallsChanged();
        }
    }

    private ChatMessage withExtra(ChatMessage m, JsonNode extra) {
        return new ChatMessage(m.id(), m.chat(), m.parentId(), m.author(), m.kind(), m.text(), m.state(), m.urgent(), m.decision(), m.origin(),
                m.context(), m.quote(), extra, m.reactions(), m.coversTo(), m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(), m.editedAt());
    }

    private void changed(ChatKey chat, Long id) {
        notifications.chatChanged(chat.project(), chat.scope(), id);
    }

    private static String clean(String text) {
        return text == null ? "" : RichText.clean(text.strip());
    }

    private static String origin(String origin) {
        if (origin == null || origin.isBlank()) {
            return "typed";
        }
        String o = origin.strip();
        return o.length() > 60 ? o.substring(0, 60) : o;
    }

    private static String reason(String reason) {
        return reason == null || reason.isBlank() ? "addressed" : cut(reason.strip(), 40);
    }

    static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
