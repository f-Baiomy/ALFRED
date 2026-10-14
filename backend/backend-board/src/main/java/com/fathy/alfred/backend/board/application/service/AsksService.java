package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.AsksUseCase;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase;
import com.fathy.alfred.backend.board.application.port.out.AskStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Ask;
import com.fathy.alfred.backend.board.domain.model.Card;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;

/**
 * Ask Claude from the board (specs/017 R24, R38). The question is kept here and sent to the cycle's chat the way ▶ sends
 * a skill ({@code /alfred-ask <id>}), so it reaches the chat that knows the cycle; Claude answers with its MCP tool and
 * the asking page hears {@code ask:<id>} on /ws/board - nothing waits by polling. Asks older than a week are swept when
 * the next one is made.
 */
@Service
public class AsksService implements AsksUseCase {

    static final Duration KEEP = Duration.ofDays(7);

    private final AskStorePort store;
    private final BoardStorePort cards;
    private final SkillRunsUseCase runs;
    private final BoardNotificationPort notifications;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public AsksService(AskStorePort store, BoardStorePort cards, SkillRunsUseCase runs, BoardNotificationPort notifications, ObjectMapper json) {
        this(store, cards, runs, notifications, json, Clock.systemUTC());
    }

    AsksService(AskStorePort store, BoardStorePort cards, SkillRunsUseCase runs, BoardNotificationPort notifications, ObjectMapper json, Clock clock) {
        this.store = store;
        this.cards = cards;
        this.runs = runs;
        this.notifications = notifications;
        this.json = json;
        this.clock = clock;
    }

    @Override
    public Sent ask(Actor actor, NewAsk a) {
        String question = a.question() == null ? "" : a.question().strip();
        if (question.isEmpty() || question.length() > Ask.MAX_QUESTION) {
            return refused("invalid", "A question is 1 to " + Ask.MAX_QUESTION + " characters");
        }
        Ask.Kind kind;
        try {
            kind = Ask.Kind.valueOf((a.kind() == null ? "SNIPPET" : a.kind().strip()).toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return refused("invalid", "kind is SNIPPET or EDITOR");
        }
        String data = a.data();
        if (data != null) {
            if (data.getBytes(StandardCharsets.UTF_8).length > Ask.MAX_DATA_BYTES) {
                return refused("invalid", "What a question carries is at most 256 KB - send the numbers that matter");
            }
            try {
                json.readTree(data);
            } catch (Exception e) {
                return refused("invalid", "What a question carries is JSON");
            }
        }
        Card card = null;
        if (a.cardId() != null && !a.cardId().isBlank()) {
            card = cards.find(a.cardId().strip()).orElse(null);
            if (card == null) {
                return refused("not-found", "No such card");
            }
        }
        String project = card != null ? card.project() : a.project() == null ? "" : a.project().strip();
        String cycleId = blank(a.cycleId()) ? card == null ? null : card.cycleId() : a.cycleId().strip();
        if (cycleId == null) {
            return refused("invalid", "Claude answers in the chat that handles a cycle - this text is not in one");
        }
        store.deleteAsksBefore(clock.instant().minus(KEEP));
        String id = UUID.randomUUID().toString();
        String where = card != null ? "card #" + card.number() : "the cycle's brief or a page";
        String prompt = "/alfred-ask " + id + "\n\nThe user asked from " + where + (kind == Ask.Kind.EDITOR ? " (in the text editor, about the text they selected)" : " (from a snippet)")
                + ": \"" + clip(question, 300) + "\". Read it with board_ask_get " + id + " and answer with board_ask_answer.";
        SkillRunsUseCase.Outcome sent = runs.request(new SkillRunsUseCase.Request(project, cycleId, null, "/alfred-ask " + id, prompt, null, null, null, false));
        if (sent.error() != null) {
            return refused(sent.error(), sent.message());
        }
        Ask ask = new Ask(id, project, cycleId, card == null ? null : card.id(), card == null ? null : card.number(), blank(a.snippetId()) ? null
                : a.snippetId().strip(), kind, question, data, Ask.State.OPEN, null, sent.run().id(), clock.instant(), null);
        store.saveAsk(ask);
        return new Sent(ask, null, null);
    }

    @Override
    public Optional<Ask> get(String id) {
        return id == null || !id.matches("^[A-Za-z0-9-]{8,64}$") ? Optional.empty() : store.findAsk(id);
    }

    @Override
    public Sent answer(Actor actor, String id, String text) {
        if (actor != Actor.CLAUDE) {
            return refused("invalid", "Claude answers an ask; the user asked it");
        }
        Optional<Ask> found = get(id);
        if (found.isEmpty()) {
            return refused("not-found", "No such ask");
        }
        Ask a = found.get();
        if (a.state() != Ask.State.OPEN) {
            return refused("conflict", a.state() == Ask.State.ANSWERED ? "Already answered" : "The asker stopped waiting");
        }
        String answer = text == null ? "" : text;
        if (answer.isBlank() || answer.getBytes(StandardCharsets.UTF_8).length > Ask.MAX_ANSWER_BYTES) {
            return refused("invalid", "An answer is text of at most 256 KB");
        }
        Ask done = new Ask(a.id(), a.project(), a.cycleId(), a.cardId(), a.cardNumber(), a.snippetId(), a.kind(), a.question(), a.data(),
                Ask.State.ANSWERED, answer, a.runId(), a.createdAt(), clock.instant());
        store.saveAsk(done);
        notifications.changed(a.project(), a.cycleId(), a.cardId(), "ask:" + a.id());
        return new Sent(done, null, null);
    }

    @Override
    public Sent cancel(String id) {
        Optional<Ask> found = get(id);
        if (found.isEmpty()) {
            return refused("not-found", "No such ask");
        }
        Ask a = found.get();
        if (a.state() != Ask.State.OPEN) {
            return new Sent(a, null, null);
        }
        if (a.runId() != null) {
            runs.stop(a.runId());
        }
        Ask stopped = new Ask(a.id(), a.project(), a.cycleId(), a.cardId(), a.cardNumber(), a.snippetId(), a.kind(), a.question(), a.data(),
                Ask.State.CANCELLED, null, a.runId(), a.createdAt(), clock.instant());
        store.saveAsk(stopped);
        notifications.changed(a.project(), a.cycleId(), a.cardId(), "ask:" + a.id());
        return new Sent(stopped, null, null);
    }

    private static Sent refused(String error, String message) {
        return new Sent(null, error, message);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    private static String clip(String s, int max) {
        String one = s.replaceAll("\\s+", " ");
        return one.length() <= max ? one : one.substring(0, max - 1) + "…";
    }
}
