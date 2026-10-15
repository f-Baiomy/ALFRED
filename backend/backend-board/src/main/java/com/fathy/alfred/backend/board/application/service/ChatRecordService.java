package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.RecordRequest;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.DeleteCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.MentionType;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * What the chat's Claude records on the board without being asked (specs/022 FR-048, FR-049): each record is written
 * through the board's own services as Claude - so Claude's limits apply exactly as on a card - and keeps what Undo needs.
 * Undo is the user's: it reverses the write as the user, or says why it no longer can (the brief changed since).
 *
 * <ul>
 *   <li>DECISION / NEXT: a line in the cycle's brief (a project chat has no brief: the message is marked, nothing else)</li>
 *   <li>CARD: a card in the Inbox, linking back to the chat</li>
 *   <li>ITEM: a proposed acceptance item, shown under the answer for the user to accept - nothing is written until then</li>
 *   <li>FIX: a Did/Found/Next fix report on the card, which moves to Fixed</li>
 * </ul>
 */
@Service
public class ChatRecordService {

    static final int MAX_LINE = 300;

    private final BoardStorePort store;
    private final CreateCardUseCase create;
    private final DeleteCardUseCase delete;
    private final ManageBriefUseCase briefs;
    private final CommentOnCardUseCase comments;
    private final MoveCardUseCase moves;
    private final ObjectMapper json;
    private final Clock clock;

    @org.springframework.beans.factory.annotation.Autowired
    public ChatRecordService(BoardStorePort store, CreateCardUseCase create, DeleteCardUseCase delete, ManageBriefUseCase briefs,
                             CommentOnCardUseCase comments, MoveCardUseCase moves, ObjectMapper json) {
        this(store, create, delete, briefs, comments, moves, json, Clock.systemUTC());
    }

    ChatRecordService(BoardStorePort store, CreateCardUseCase create, DeleteCardUseCase delete, ManageBriefUseCase briefs,
                      CommentOnCardUseCase comments, MoveCardUseCase moves, ObjectMapper json, Clock clock) {
        this.store = store;
        this.create = create;
        this.delete = delete;
        this.briefs = briefs;
        this.comments = comments;
        this.moves = moves;
        this.json = json;
        this.clock = clock;
    }

    /** What applying one record did: the record to store (id 0), or why it was refused; ITEM adds a proposal to the answer. */
    record Applied(ChatRecord record, String refused, JsonNode proposal) {
    }

    Applied apply(ChatMessage answer, RecordRequest r) {
        if (r == null || r.kind() == null || r.text() == null || r.text().isBlank()) {
            return refused("A record needs its kind and text");
        }
        String text = r.text().strip();
        return switch (r.kind()) {
            case DECISION, NEXT -> brief(answer, r.kind(), text);
            case CARD -> card(answer, r, text);
            case ITEM -> item(answer, r, text);
            case FIX -> fix(answer, r, text);
        };
    }

    private Applied brief(ChatMessage answer, ChatRecord.Kind kind, String text) {
        String label = kind == ChatRecord.Kind.DECISION ? "decision" : "open question";
        if (answer.chat().isProject()) {
            return ok(answer, kind, "chat", "noted the " + label + " \"" + cut(text) + "\" in this chat (a project has no brief)", null);
        }
        String cycleId = answer.chat().cycleId();
        String before = briefs.brief(cycleId).text();
        String after = appendToBrief(before, kind == ChatRecord.Kind.DECISION ? "Decision" : "Next", text, answer.id());
        ManageBriefUseCase.BriefOutcome out = briefs.putBrief(Actor.CLAUDE, cycleId, after);
        if (out.outcome() != CardChange.Outcome.OK) {
            return refused(out.message());
        }
        ObjectNode undo = json.createObjectNode().put("cycleId", cycleId).put("before", before == null ? "" : before)
                .put("after", out.brief().text());
        return ok(answer, kind, "brief", "recorded the " + label + " \"" + cut(text) + "\" in the brief", undo);
    }

    /** One line at the end of the brief, in the brief's own format (HTML from the editor, else Markdown). */
    static String appendToBrief(String brief, String head, String text, long messageId) {
        String b = brief == null ? "" : brief;
        if (RichText.isHtml(b)) {
            return b + "<p><strong>" + head + "</strong> (chat #" + messageId + "): " + escape(text) + "</p>";
        }
        return (b.isBlank() ? "" : b.stripTrailing() + "\n\n") + "**" + head + "** (chat #" + messageId + "): " + text;
    }

    private Applied card(ChatMessage answer, RecordRequest r, String text) {
        String title = r.card() != null && r.card().title() != null && !r.card().title().isBlank() ? r.card().title().strip() : cut(text);
        String description = r.card() != null && r.card().description() != null && !r.card().description().isBlank()
                ? r.card().description() : text;
        CardKind kind = kindOf(r.card() == null ? null : r.card().kind());
        description = description + "\n\nFrom the board chat: " + chatMention(answer);
        CardChange out = create.create(Actor.CLAUDE, new CreateCardUseCase.NewCard(answer.chat().project(), kind, title, description, Set.of(),
                answer.chat().isProject() ? null : answer.chat().cycleId(), CardStatus.INBOX, List.of()));
        if (out.outcome() != CardChange.Outcome.OK) {
            return refused(out.message());
        }
        Card card = out.card().card();
        ObjectNode undo = json.createObjectNode().put("cardId", card.id());
        return ok(answer, ChatRecord.Kind.CARD, card.id(), "added #" + card.number() + " \"" + cut(title) + "\" to the Inbox", undo);
    }

    private Applied item(ChatMessage answer, RecordRequest r, String text) {
        if (answer.chat().isProject()) {
            return refused("An acceptance item belongs to a cycle's spec - ask in the cycle's chat");
        }
        String file = r.item() != null && r.item().file() != null && !r.item().file().isBlank() ? r.item().file().strip() : "spec.md";
        String itemText = r.item() != null && r.item().text() != null && !r.item().text().isBlank() ? r.item().text().strip() : text;
        String id = "item-" + answer.id() + "-" + Math.abs((file + itemText).hashCode());
        ObjectNode proposal = json.createObjectNode().put("id", id).put("kind", "item").put("text", "add to " + file + ": " + itemText)
                .put("file", file).put("item", itemText);
        if (r.item() != null && r.item().evidence() != null) {
            proposal.put("evidence", r.item().evidence());
        }
        ObjectNode undo = json.createObjectNode().put("proposal", id);
        return new Applied(new ChatRecord(0, answer.id(), ChatRecord.Kind.ITEM, file, "proposed the acceptance item \"" + cut(itemText)
                + "\" for " + file + " - accept it below", undo.toString(), clock.instant(), null), null, proposal);
    }

    private Applied fix(ChatMessage answer, RecordRequest r, String text) {
        if (r.fix() == null || r.fix().card() <= 0) {
            return refused("A fix record names its card");
        }
        Card card = store.findByNumber(answer.chat().project(), r.fix().card()).orElse(null);
        if (card == null) {
            return refused("No card #" + r.fix().card() + " in this project");
        }
        CardStatus before = card.status();
        String report = r.fix().report() == null || r.fix().report().isBlank() ? text : r.fix().report();
        String plan = r.fix().plan() == null || r.fix().plan().isBlank() ? "Re-test: send the calls this fix is about again." : r.fix().plan();
        CommentOnCardUseCase.CommentOutcome comment = comments.comment(Actor.CLAUDE, card.id(), new CommentOnCardUseCase.Comment(null,
                report, "Fixed from the board chat " + chatMention(answer) + ".", plan, null));
        if (comment.outcome() != CardChange.Outcome.OK) {
            return refused(comment.message());
        }
        if (before != CardStatus.FIXED) {
            CardChange moved = moves.move(Actor.CLAUDE, card.id(), CardStatus.FIXED);
            if (moved.outcome() != CardChange.Outcome.OK) {
                return ok(answer, ChatRecord.Kind.FIX, card.id(), "wrote the fix report on #" + card.number() + " (it stays " + before
                        + ": " + moved.message() + ")", json.createObjectNode().put("cardId", card.id()));
            }
        }
        ObjectNode undo = json.createObjectNode().put("cardId", card.id()).put("status", before.name());
        return ok(answer, ChatRecord.Kind.FIX, card.id(), "wrote the fix report on #" + card.number() + " and moved it to Fixed", undo);
    }

    /** Reverses one record as the user; empty when done, else why not. */
    String undo(ChatRecord record) {
        JsonNode undo;
        try {
            undo = record.undo() == null ? json.createObjectNode() : json.readTree(record.undo());
        } catch (Exception e) {
            return "This record cannot be undone";
        }
        if (undo.path("imported").asBoolean(false)) {
            return "An imported record cannot be undone here - what it wrote belongs to the board it came from";
        }
        switch (record.kind()) {
            case DECISION, NEXT -> {
                if (!undo.has("cycleId")) {
                    return null; // a project chat's decision: nothing was written
                }
                String cycleId = undo.path("cycleId").asText();
                String now = briefs.brief(cycleId).text();
                if (!undo.path("after").asText().equals(now == null ? "" : now)) {
                    return "The brief changed since - edit it there";
                }
                ManageBriefUseCase.BriefOutcome out = briefs.putBrief(Actor.USER, cycleId, undo.path("before").asText());
                return out.outcome() == CardChange.Outcome.OK ? null : out.message();
            }
            case CARD -> {
                CardChange out = delete.delete(Actor.USER, undo.path("cardId").asText());
                return out.outcome() == CardChange.Outcome.OK || out.outcome() == CardChange.Outcome.NOT_FOUND ? null : out.message();
            }
            case FIX -> {
                if (!undo.has("status")) {
                    return null;
                }
                CardChange out = moves.move(Actor.USER, undo.path("cardId").asText(), CardStatus.valueOf(undo.path("status").asText()));
                return out.outcome() == CardChange.Outcome.OK || out.outcome() == CardChange.Outcome.NOT_FOUND ? null : out.message();
            }
            case ITEM -> {
                return null; // the proposal is taken off the answer by the caller
            }
            default -> {
                return "This record cannot be undone";
            }
        }
    }

    /** Removes a proposal (an undone ITEM) from a message's payload. */
    JsonNode withoutProposal(JsonNode extra, String proposalId) {
        if (extra == null || !extra.isObject() || !extra.path("proposals").isArray()) {
            return extra;
        }
        ObjectNode copy = ((ObjectNode) extra).deepCopy();
        ArrayNode kept = json.createArrayNode();
        extra.path("proposals").forEach(p -> {
            if (!proposalId.equals(p.path("id").asText())) {
                kept.add(p);
            }
        });
        copy.set("proposals", kept);
        return copy;
    }

    static String chatMention(ChatMessage m) {
        return "@[chat:" + m.chat().project() + "/" + m.chat().scope() + "#" + m.id() + "|chat #" + m.id() + "]";
    }

    static MentionRef chatRef(ChatMessage m) {
        return new MentionRef(MentionType.CHAT, m.chat().project() + "/" + m.chat().scope() + "#" + m.id(), "chat #" + m.id());
    }

    private Applied ok(ChatMessage answer, ChatRecord.Kind kind, String target, String line, JsonNode undo) {
        return new Applied(new ChatRecord(0, answer.id(), kind, target, line, undo == null ? null : undo.toString(), clock.instant(), null), null, null);
    }

    private static Applied refused(String why) {
        return new Applied(null, why == null || why.isBlank() ? "Refused" : why, null);
    }

    private static CardKind kindOf(String kind) {
        try {
            return kind == null ? CardKind.BUG : CardKind.valueOf(kind.strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return CardKind.BUG;
        }
    }

    private static String cut(String text) {
        String one = text.replaceAll("\\s+", " ").strip();
        return one.length() <= MAX_LINE ? one : one.substring(0, MAX_LINE - 1) + "…";
    }

    private static String escape(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
