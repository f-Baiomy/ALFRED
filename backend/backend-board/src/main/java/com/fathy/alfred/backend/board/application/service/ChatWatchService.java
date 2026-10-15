package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ChatWatchUseCase;
import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

/**
 * The board chats' watches (specs/022 FR-030, FR-031) - events only, never a timer:
 * <ul>
 *   <li>STATUS ("5xx", "404", "500") and ERROR_LOG (an endpoint part, or "*") fire on a completed live call;</li>
 *   <li>ITEM_PASSES (an item key, "AC5" or the start of its text) fires when the item's verdict becomes MET - checked on the
 *   board's "requirements" signal;</li>
 *   <li>each "tell me when" watch posts one line in its chat, under the message that set it, and is gone;</li>
 *   <li>"watch while I test" (the chat's {@code watching} setting) keeps one waiting check task per cycle chat whose
 *   Claude is on: the calls that arrive while it waits join it, so the chat's Claude checks them as one batch.</li>
 * </ul>
 * The work runs on its own thread: a completed call never waits for it.
 */
@Service
public class ChatWatchService implements ChatWatchUseCase {

    private static final Logger log = LoggerFactory.getLogger(ChatWatchService.class);

    private final ChatStorePort chats;
    private final CallFactsPort facts;
    private final java.util.function.Supplier<RequirementUseCase> requirements;
    private final java.util.function.Supplier<LiveWorkUseCase> live;
    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final Executor executor;

    @Autowired
    public ChatWatchService(ChatStorePort chats, CallFactsPort facts, ObjectProvider<RequirementUseCase> requirements,
                            ObjectProvider<LiveWorkUseCase> live, BoardNotificationPort notifications, BoardChangeFeed feed) {
        this(chats, facts, requirements::getIfAvailable, live::getIfAvailable, notifications, feed, Clock.systemUTC(), Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "board-chat-watch");
            t.setDaemon(true);
            return t;
        }));
    }

    ChatWatchService(ChatStorePort chats, CallFactsPort facts, java.util.function.Supplier<RequirementUseCase> requirements,
                     java.util.function.Supplier<LiveWorkUseCase> live,
                     BoardNotificationPort notifications, BoardChangeFeed feed, Clock clock, Executor executor) {
        this.chats = chats;
        this.facts = facts;
        this.requirements = requirements;
        this.live = live;
        this.notifications = notifications;
        this.clock = clock;
        this.executor = executor;
        feed.observe((project, cycleId, cardId, what) -> {
            if ("requirements".equals(what) && cycleId != null) {
                run(() -> verdictsChanged(cycleId));
            }
        });
    }

    private void run(Runnable work) {
        executor.execute(() -> {
            try {
                work.run();
            } catch (RuntimeException e) {
                log.warn("A board chat watch failed: {}", e.toString());
            }
        });
    }

    @Override
    public void callCompleted(String project, String callId, String endpoint, Integer status) {
        String p = project == null ? "" : project;
        run(() -> {
            fireCallWatches(p, callId, endpoint, status);
            queueBatches(p, callId);
        });
    }

    // ------------------------------------------------------------------------------------------------- tell me when

    void fireCallWatches(String project, String callId, String endpoint, Integer status) {
        CallFacts known = null;
        for (ChatWatch w : chats.watches(project)) {
            if (w.kind() == ChatWatch.Kind.STATUS && statusMatches(w.target(), status)) {
                fire(w, "a call answered " + status + ": @[call:in:" + callId + "|" + label(endpoint) + " · " + status + "]");
            } else if (w.kind() == ChatWatch.Kind.ERROR_LOG && endpointMatches(w.target(), endpoint)) {
                if (known == null) {
                    known = facts.facts(callId, null, Set.of()).orElse(null);
                }
                if (known != null && known.errors() != null && known.errors() > 0) {
                    fire(w, "an ERROR was logged by @[call:in:" + callId + "|" + label(endpoint) + "]");
                }
            }
        }
    }

    void verdictsChanged(String cycleId) {
        RequirementUseCase reqs = requirements.get();
        if (reqs == null) {
            return;
        }
        List<RequirementUseCase.Requirement> items = null;
        for (ChatWatch w : allItemWatches(cycleId)) {
            if (items == null) {
                items = reqs.requirements(cycleId).items();
            }
            Optional<RequirementUseCase.Requirement> item = find(items, w.target());
            if (item.isPresent() && item.get().verdict() != null && item.get().verdict().verdict() == ItemVerdict.Verdict.MET) {
                String call = item.get().verdict().callId();
                fire(w, "it passes now" + (call == null ? "" : " - @[call:in:" + call + "@" + cycleId + "|the call that shows it]"));
            }
        }
    }

    private List<ChatWatch> allItemWatches(String cycleId) {
        // Watches are kept per project; an item watch lives in its cycle's chat.
        return chats.watchesOfCycle(cycleId).stream().filter(w -> w.kind() == ChatWatch.Kind.ITEM_PASSES).toList();
    }

    static Optional<RequirementUseCase.Requirement> find(List<RequirementUseCase.Requirement> items, String target) {
        String t = target == null ? "" : target.strip();
        java.util.regex.Matcher ac = java.util.regex.Pattern.compile("(?i)^AC\\s*(\\d+)$").matcher(t);
        if (ac.matches()) {
            int n = Integer.parseInt(ac.group(1));
            return n >= 1 && n <= items.size() ? Optional.of(items.get(n - 1)) : Optional.empty();
        }
        String lower = t.toLowerCase(Locale.ROOT);
        return items.stream().filter(i -> t.equals(i.itemKey()) || (!lower.isEmpty() && i.text() != null
                && i.text().toLowerCase(Locale.ROOT).startsWith(lower))).findFirst();
    }

    static boolean statusMatches(String target, Integer status) {
        if (status == null || target == null) {
            return false;
        }
        String t = target.strip().toLowerCase(Locale.ROOT);
        if (t.matches("[1-5]xx")) {
            return status / 100 == t.charAt(0) - '0';
        }
        return t.matches("\\d{3}") && Integer.parseInt(t) == status;
    }

    static boolean endpointMatches(String target, String endpoint) {
        String t = target == null ? "" : target.strip();
        return t.isEmpty() || t.equals("*") || (endpoint != null && endpoint.toLowerCase(Locale.ROOT).contains(t.toLowerCase(Locale.ROOT)));
    }

    /** One line, once: the watch is removed first, so two calls at the same moment never post it twice. */
    private void fire(ChatWatch w, String what) {
        if (!chats.deleteWatch(w.id())) {
            return;
        }
        ChatMessage line = chats.insert(new ChatMessage(0, w.chat(), w.messageId(), ChatMessage.Author.ALFRED, ChatMessage.Kind.SYSTEM,
                "🔔 " + w.label() + " - " + what, ChatMessage.State.DONE, false, false, "watch", List.of(), null, null, Map.of(), null, null,
                null, false, clock.instant(), null));
        notifications.chatChanged(w.chat().project(), w.chat().scope(), line.id());
    }

    // -------------------------------------------------------------------------------------------- watch while I test

    void queueBatches(String project, String callId) {
        LiveWorkUseCase lw = live.get();
        for (ChatKey chat : chats.watching(project)) {
            if (chat.isProject() || lw == null || lw.cycleChat(chat.cycleId()).isEmpty()) {
                continue; // a batch is checked by the cycle chat's own Claude; with none on, nothing queues
            }
            Optional<ChatMessage> waiting = chats.openTasks(chat).stream()
                    .filter(m -> ChatService.WATCH.equals(m.origin()) && m.state() == ChatMessage.State.WAITING).findFirst();
            if (waiting.isPresent()) {
                ChatMessage t = waiting.get();
                int n = t.extra() == null ? 1 : t.extra().path("calls").asInt(1);
                chats.update(withCalls(t, n + 1, t.extra() == null ? callId : t.extra().path("since").asText(callId)));
            } else {
                ChatMessage t = chats.insert(new ChatMessage(0, chat, null, ChatMessage.Author.ALFRED, ChatMessage.Kind.TASK,
                        "Watch while I test: new calls arrived - check them as one batch (wait_for_calls with sinceCallId and settleSec, then "
                                + "check_calls), post the findings with chat_reply; nothing found: chat_reply with extra {\"quiet\": true}.",
                        ChatMessage.State.WAITING, false, false, ChatService.WATCH, List.of(), null,
                        com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("calls", 1).put("since", callId),
                        Map.of(), null, null, null, false, clock.instant(), null));
                notifications.chatChanged(chat.project(), chat.scope(), t.id());
            }
        }
    }

    private static ChatMessage withCalls(ChatMessage t, int calls, String since) {
        return new ChatMessage(t.id(), t.chat(), t.parentId(), t.author(), t.kind(), t.text(), t.state(), t.urgent(), t.decision(), t.origin(),
                t.context(), t.quote(), com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("calls", calls).put("since", since),
                t.reactions(), t.coversTo(), t.replyTo(), t.bridgeFrom(), t.superseded(), t.createdAt(), t.editedAt());
    }

    private static String label(String endpoint) {
        String e = endpoint == null || endpoint.isBlank() ? "call" : endpoint.replace("|", "/").replace("]", ")");
        return e.length() > 80 ? e.substring(0, 79) + "…" : e;
    }
}
