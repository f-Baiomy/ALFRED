package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.ChatProposalUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.CloseCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ReopenCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.UndoCloseUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChecklistFile;
import com.fathy.alfred.backend.board.domain.model.ChecklistItem;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * Claude's proposals in a chat answer, applied as the user's action after the board is checked again (specs/022 FR-026),
 * with Undo for 60 seconds (FR-046). A proposal is the JSON Claude wrote in the answer's {@code extra.proposals}: an
 * {@code id}, a {@code kind} and its fields -
 * <ul>
 *   <li>{@code verify} {card} - Fixed → Verified</li>
 *   <li>{@code close} {card, reason?} - closed as Fine</li>
 *   <li>{@code move} {card, status}</li>
 *   <li>{@code mark} {file, itemKey, mark, evidence?} - a checklist mark with its call evidence</li>
 *   <li>{@code item} {file, item} - a new acceptance item at the end of the spec file</li>
 * </ul>
 * Its {@code state} becomes applied / declined / outdated (with {@code why}); an undo clears it again. Undo tokens live in
 * memory only: a restart ends them, as the minute would.
 */
@Service
public class ChatProposalService implements ChatProposalUseCase {

    private final ChatStorePort chats;
    private final BoardStorePort store;
    private final MoveCardUseCase moves;
    private final CloseCardUseCase closes;
    private final UndoCloseUseCase undoClose;
    private final ReopenCardUseCase reopens;
    private final MarkChecklistUseCase marks;
    private final ManageSpecFilesUseCase specs;
    private final BoardNotificationPort notifications;
    private final Clock clock;
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    /** What one accept changed, to put back. */
    private record Pending(long messageId, Instant until, List<String> ids, List<Supplier<String>> undos) {
    }

    @Autowired
    public ChatProposalService(ChatStorePort chats, BoardStorePort store, MoveCardUseCase moves, CloseCardUseCase closes, UndoCloseUseCase undoClose,
                               ReopenCardUseCase reopens, MarkChecklistUseCase marks, ManageSpecFilesUseCase specs, BoardNotificationPort notifications,
                               BoardChangeFeed feed) {
        this(chats, store, moves, closes, undoClose, reopens, marks, specs, notifications, feed, Clock.systemUTC());
    }

    ChatProposalService(ChatStorePort chats, BoardStorePort store, MoveCardUseCase moves, CloseCardUseCase closes, UndoCloseUseCase undoClose,
                        ReopenCardUseCase reopens, MarkChecklistUseCase marks, ManageSpecFilesUseCase specs, BoardNotificationPort notifications,
                        BoardChangeFeed feed, Clock clock) {
        this.chats = chats;
        this.store = store;
        this.moves = moves;
        this.closes = closes;
        this.undoClose = undoClose;
        this.reopens = reopens;
        this.marks = marks;
        this.specs = specs;
        this.notifications = feed.feeding(notifications);
        this.clock = clock;
    }

    @Override
    public synchronized Result<Outcome> decide(Actor actor, long messageId, List<String> accept, List<String> decline) {
        if (actor == Actor.CLAUDE) {
            return Result.no(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Proposals are the user's to accept");
        }
        ChatMessage m = chats.find(messageId).orElse(null);
        if (m == null || m.extra() == null || !m.extra().path("proposals").isArray()) {
            return Result.no(CardChange.Outcome.NOT_FOUND, "Message " + messageId + " proposes nothing");
        }
        List<String> yes = accept == null ? List.of() : accept;
        List<String> no = decline == null ? List.of() : decline;
        if (yes.isEmpty() && no.isEmpty()) {
            return Result.no(CardChange.Outcome.INVALID, "Accept or decline at least one proposal");
        }
        ObjectNode extra = ((ObjectNode) m.extra()).deepCopy();
        Map<String, String> results = new LinkedHashMap<>();
        List<String> applied = new ArrayList<>();
        List<Supplier<String>> undos = new ArrayList<>();
        for (JsonNode node : extra.path("proposals")) {
            if (!node.isObject()) {
                continue;
            }
            ObjectNode p = (ObjectNode) node;
            String id = p.path("id").asText("");
            boolean take = yes.contains(id);
            if (!take && !no.contains(id)) {
                continue;
            }
            if (p.hasNonNull("state")) {
                results.put(id, "already " + p.path("state").asText());
                continue;
            }
            if (!take) {
                p.put("state", "declined");
                results.put(id, "declined");
                continue;
            }
            String why = check(m, p);
            if (why != null) {
                p.put("state", "outdated").put("why", why);
                results.put(id, why);
                continue;
            }
            Applied a = apply(m, p, p);
            if (a.failed() != null) {
                results.put(id, a.failed()); // stays open: nothing changed, it can be tried again
                continue;
            }
            p.put("state", "applied");
            results.put(id, "applied");
            applied.add(id);
            undos.add(a.undo());
        }
        for (String id : yes) {
            results.putIfAbsent(id, "no such proposal");
        }
        chats.update(withExtra(m, extra));
        String token = null;
        if (!applied.isEmpty()) {
            token = UUID.randomUUID().toString();
            pending.put(token, new Pending(m.id(), clock.instant().plusSeconds(UNDO_SECONDS), applied, undos));
            pending.values().removeIf(x -> x.until().isBefore(clock.instant()));
        }
        notifications.chatChanged(m.chat().project(), m.chat().scope(), m.id());
        return Result.ok(new Outcome(results, token));
    }

    @Override
    public Result<Map<String, String>> check(long messageId) {
        ChatMessage m = chats.find(messageId).orElse(null);
        if (m == null) {
            return Result.no(CardChange.Outcome.NOT_FOUND, "No chat message " + messageId);
        }
        Map<String, String> out = new LinkedHashMap<>();
        if (m.extra() != null) {
            for (JsonNode p : m.extra().path("proposals")) {
                if (p.isObject() && !p.hasNonNull("state")) {
                    out.put(p.path("id").asText(""), check(m, p));
                }
            }
        }
        return Result.ok(out);
    }

    @Override
    public synchronized Result<Void> undo(Actor actor, String token) {
        if (actor == Actor.CLAUDE) {
            return Result.no(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Undo is the user's");
        }
        Pending p = token == null ? null : pending.remove(token);
        if (p == null || p.until().isBefore(clock.instant())) {
            return Result.no(CardChange.Outcome.CONFLICT, "Too late to undo - the minute is over (change it on the board)");
        }
        List<String> failed = new ArrayList<>();
        for (int i = p.undos().size() - 1; i >= 0; i--) {
            String why = p.undos().get(i).get();
            if (why != null) {
                failed.add(why);
            }
        }
        chats.find(p.messageId()).ifPresent(m -> {
            ObjectNode extra = ((ObjectNode) m.extra()).deepCopy();
            for (JsonNode node : extra.path("proposals")) {
                if (node.isObject() && p.ids().contains(node.path("id").asText())) {
                    ((ObjectNode) node).remove(List.of("state", "why"));
                }
            }
            chats.update(withExtra(m, extra));
            notifications.chatChanged(m.chat().project(), m.chat().scope(), m.id());
        });
        return failed.isEmpty() ? Result.ok(null) : Result.no(CardChange.Outcome.CONFLICT, "Undone, except: " + String.join("; ", failed));
    }

    @Override
    public synchronized Result<Void> undoOne(Actor actor, long messageId, String proposalId) {
        if (actor == Actor.CLAUDE) {
            return Result.no(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Undo is the user's");
        }
        ChatMessage m = chats.find(messageId).orElse(null);
        ObjectNode extra = m == null || m.extra() == null ? null : ((ObjectNode) m.extra()).deepCopy();
        ObjectNode p = null;
        if (extra != null) {
            for (JsonNode node : extra.path("proposals")) {
                if (node.isObject() && node.path("id").asText("").equals(proposalId)) {
                    p = (ObjectNode) node;
                }
            }
        }
        if (p == null) {
            return Result.no(CardChange.Outcome.NOT_FOUND, "No proposal " + proposalId + " on message " + messageId);
        }
        if (!"applied".equals(p.path("state").asText())) {
            return Result.no(CardChange.Outcome.CONFLICT, "Only an applied proposal can be undone");
        }
        String failed = putBack(m, p);
        if (failed != null) {
            return Result.no(CardChange.Outcome.CONFLICT, failed);
        }
        p.remove(List.of("state", "why", "before", "after", "wasMark", "wasEvidence"));
        chats.update(withExtra(m, extra));
        pending.values().removeIf(x -> x.messageId() == messageId && x.ids().contains(proposalId));
        notifications.chatChanged(m.chat().project(), m.chat().scope(), m.id());
        return Result.ok(null);
    }

    /** What an applied proposal changed, put back - or why not (the board changed since). */
    private String putBack(ChatMessage m, ObjectNode p) {
        String kind = p.path("kind").asText("").toLowerCase(Locale.ROOT);
        String cycleId = m.chat().cycleId();
        switch (kind) {
            case "verify", "move", "close" -> {
                Card card = card(m, p).orElse(null);
                CardStatus before = p.hasNonNull("before") ? status(p.path("before").asText()) : null;
                // a close needs no kept status (undo-close or reopen puts the card back); a move does
                CardStatus after = p.hasNonNull("after") ? status(p.path("after").asText()) : kind.equals("close") ? CardStatus.CLOSED : null;
                if (card == null || after == null || (before == null && !kind.equals("close"))) {
                    return "This was applied before Undo kept what it changed - change the card on the board";
                }
                if (card.status() != after) {
                    return "#" + card.number() + " changed since (it is " + card.status().name().replace('_', ' ').toLowerCase(Locale.ROOT)
                            + " now) - change it on the board";
                }
                if (kind.equals("close")) {
                    CardChange quick = undoClose.undoClose(Actor.USER, card.id());
                    return quick.outcome() == CardChange.Outcome.OK ? null : message(reopens.reopen(Actor.USER, card.id()));
                }
                return message(moves.move(Actor.USER, card.id(), before));
            }
            case "mark" -> {
                if (!p.hasNonNull("wasMark")) {
                    return "A checklist mark cannot be cleared - change it in the checklist";
                }
                var out = marks.mark(Actor.USER, cycleId, p.path("file").asText(), p.path("itemKey").asText(), mark(p.path("wasMark").asText()),
                        p.path("wasEvidence").asText(""));
                return out.outcome() == CardChange.Outcome.OK ? null : out.message();
            }
            case "item" -> {
                String file = p.path("file").asText("spec.md");
                String line = "- [ ] " + p.path("item").asText().strip();
                String now = store.spec(cycleId, file).map(SpecFile::content).orElse(null);
                int at = now == null ? -1 : now.indexOf(line);
                if (at < 0) {
                    return file + " changed since - edit it there";
                }
                int end = at + line.length();
                if (end < now.length() && now.charAt(end) == '\n') {
                    end++;
                }
                String without = now.substring(0, at) + now.substring(end);
                return specs.put(Actor.USER, cycleId, file, without).outcome() == CardChange.Outcome.OK ? null : file + " could not be changed";
            }
            default -> {
                return "Nothing to put back";
            }
        }
    }

    @Override
    public Result<Void> consent(Actor actor, long messageId, boolean yes) {
        if (actor == Actor.CLAUDE) {
            return Result.no(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Consent is the user's");
        }
        ChatMessage m = chats.find(messageId).orElse(null);
        if (m == null || m.extra() == null || !m.extra().path("consent").isObject()) {
            return Result.no(CardChange.Outcome.NOT_FOUND, "Message " + messageId + " asks for nothing to confirm");
        }
        if (m.extra().path("consent").hasNonNull("decided")) {
            return Result.no(CardChange.Outcome.CONFLICT, "Already decided");
        }
        ObjectNode extra = ((ObjectNode) m.extra()).deepCopy();
        ((ObjectNode) extra.get("consent")).put("decided", yes ? "yes" : "no").put("decidedAt", clock.instant().toString());
        chats.update(withExtra(m, extra));
        notifications.chatChanged(m.chat().project(), m.chat().scope(), m.id());
        return Result.ok(null);
    }

    // ---------------------------------------------------------------------------------------------- check and apply

    /** Null when the proposal can be applied now; "already done" or "outdated: <why>" when the board moved on. */
    String check(ChatMessage m, JsonNode p) {
        String kind = p.path("kind").asText("").toLowerCase(Locale.ROOT);
        String cycleId = m.chat().cycleId();
        switch (kind) {
            case "verify", "close", "move" -> {
                Card card = card(m, p).orElse(null);
                if (card == null) {
                    return "outdated: card #" + p.path("card").asInt() + " is not on this board";
                }
                CardStatus now = card.status();
                if (kind.equals("verify")) {
                    return now == CardStatus.VERIFIED || now == CardStatus.DONE ? "already done"
                            : now == CardStatus.FIXED ? null : "outdated: #" + card.number() + " is " + label(now) + " now, not Fixed";
                }
                if (kind.equals("close")) {
                    return now == CardStatus.CLOSED ? "already done" : null;
                }
                CardStatus target = status(p.path("status").asText());
                if (target == null || target == CardStatus.CLOSED) {
                    return "outdated: no column \"" + p.path("status").asText() + "\"";
                }
                return now == target ? "already done" : now == CardStatus.CLOSED ? "outdated: #" + card.number() + " is closed" : null;
            }
            case "mark" -> {
                if (cycleId.isEmpty()) {
                    return "outdated: a checklist belongs to a cycle";
                }
                Mark mark = mark(p.path("mark").asText());
                if (mark == null) {
                    return "outdated: no mark \"" + p.path("mark").asText() + "\"";
                }
                ChecklistItem item = item(cycleId, p.path("file").asText(), p.path("itemKey").asText()).orElse(null);
                if (item == null) {
                    return "outdated: the item is no longer in " + p.path("file").asText();
                }
                return item.mark() != null && item.mark().mark() == mark ? "already done" : null;
            }
            case "item" -> {
                if (cycleId.isEmpty()) {
                    return "outdated: an acceptance item belongs to a cycle";
                }
                String text = p.path("item").asText("").strip();
                if (text.isEmpty()) {
                    return "outdated: the item has no text";
                }
                Optional<SpecFile> spec = store.spec(cycleId, p.path("file").asText("spec.md"));
                return spec.isPresent() && spec.get().content().contains(text) ? "already done" : null;
            }
            default -> {
                return "outdated: \"" + kind + "\" is not something the chat can apply";
            }
        }
    }

    private record Applied(String failed, Supplier<String> undo) {
    }

    /** Applies one proposal as the user; {@code kept} gets what it changed (before, wasMark...) so Undo can put it back later. */
    private Applied apply(ChatMessage m, JsonNode p, ObjectNode kept) {
        String kind = p.path("kind").asText("").toLowerCase(Locale.ROOT);
        String cycleId = m.chat().cycleId();
        switch (kind) {
            case "verify", "move" -> {
                Card card = card(m, p).orElseThrow();
                CardStatus before = card.status();
                CardStatus target = kind.equals("verify") ? CardStatus.VERIFIED : status(p.path("status").asText());
                CardChange out = moves.move(Actor.USER, card.id(), target);
                kept.put("before", before.name()).put("after", target.name());
                return out.outcome() == CardChange.Outcome.OK ? new Applied(null, () -> message(moves.move(Actor.USER, card.id(), before)))
                        : new Applied(out.message(), null);
            }
            case "close" -> {
                Card card = card(m, p).orElseThrow();
                String reason = p.path("reason").asText("").isBlank() ? "Accepted from the board chat" : p.path("reason").asText();
                kept.put("before", card.status().name()).put("after", CardStatus.CLOSED.name());
                CardChange out = closes.close(Actor.USER, card.id(), Resolution.FINE, reason);
                return out.outcome() == CardChange.Outcome.OK ? new Applied(null, () -> message(undoClose.undoClose(Actor.USER, card.id())))
                        : new Applied(out.message(), null);
            }
            case "mark" -> {
                String file = p.path("file").asText();
                String key = p.path("itemKey").asText();
                ChecklistItem item = item(cycleId, file, key).orElseThrow();
                MarkChecklistUseCase.MarkOutcome out = marks.mark(Actor.USER, cycleId, file, key, mark(p.path("mark").asText()),
                        p.path("evidence").asText(""));
                if (out.outcome() != CardChange.Outcome.OK) {
                    return new Applied(out.message(), null);
                }
                var was = item.mark();
                if (was != null) {
                    kept.put("wasMark", was.mark().name()).put("wasEvidence", was.evidence() == null ? "" : was.evidence());
                }
                return new Applied(null, () -> was == null ? "the new mark on " + key + " stays (a checklist mark cannot be cleared - change it there)"
                        : marks.mark(Actor.USER, cycleId, file, key, was.mark(), was.evidence()).outcome() == CardChange.Outcome.OK ? null
                        : "the mark on " + key + " could not be put back");
            }
            case "item" -> {
                String file = p.path("file").asText("spec.md");
                String before = store.spec(cycleId, file).map(SpecFile::content).orElse(null);
                String base = before == null ? "## Acceptance\n" : before.endsWith("\n") ? before : before + "\n";
                String after = base + "- [ ] " + p.path("item").asText().strip() + "\n";
                ManageSpecFilesUseCase.SpecOutcome out = specs.put(Actor.USER, cycleId, file, after);
                if (out.outcome() != CardChange.Outcome.OK) {
                    return new Applied(out.message(), null);
                }
                return new Applied(null, () -> {
                    String now = store.spec(cycleId, file).map(SpecFile::content).orElse(null);
                    if (now == null || !now.contains(p.path("item").asText().strip())) {
                        return file + " changed since - edit it there";
                    }
                    if (before == null) {
                        return specs.delete(Actor.USER, cycleId, file) == CardChange.Outcome.OK ? null : file + " could not be removed";
                    }
                    return specs.put(Actor.USER, cycleId, file, before).outcome() == CardChange.Outcome.OK ? null : file + " could not be put back";
                });
            }
            default -> {
                return new Applied("not something the chat can apply", null);
            }
        }
    }

    // --------------------------------------------------------------------------------------------------------- helpers

    private Optional<Card> card(ChatMessage m, JsonNode p) {
        int n = p.path("card").asInt(-1);
        return n <= 0 ? Optional.empty() : store.findByNumber(m.chat().project(), n);
    }

    private Optional<ChecklistItem> item(String cycleId, String file, String key) {
        for (ChecklistFile f : marks.checklist(cycleId)) {
            if (f.fileName().equals(file)) {
                return f.items().stream().filter(i -> i.key().equals(key)).findFirst();
            }
        }
        return Optional.empty();
    }

    private static String message(CardChange c) {
        return c.outcome() == CardChange.Outcome.OK ? null : c.message();
    }

    private static CardStatus status(String s) {
        try {
            return CardStatus.valueOf(s.strip().toUpperCase(Locale.ROOT).replace(' ', '_'));
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Mark mark(String s) {
        try {
            return Mark.valueOf(s.strip().toUpperCase(Locale.ROOT).replace(' ', '_'));
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String label(CardStatus s) {
        return s.name().charAt(0) + s.name().substring(1).toLowerCase(Locale.ROOT).replace('_', ' ');
    }

    private static ChatMessage withExtra(ChatMessage m, JsonNode extra) {
        return new ChatMessage(m.id(), m.chat(), m.parentId(), m.author(), m.kind(), m.text(), m.state(), m.urgent(), m.decision(), m.origin(),
                m.context(), m.quote(), extra, m.reactions(), m.coversTo(), m.replyTo(), m.bridgeFrom(), m.superseded(), m.createdAt(), m.editedAt());
    }
}
