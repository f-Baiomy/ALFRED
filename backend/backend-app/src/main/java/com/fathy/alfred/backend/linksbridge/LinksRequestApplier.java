package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.BriefCommentsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentExtrasUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.GetCardUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.comments.application.port.in.CreateCommentUseCase;
import com.fathy.alfred.backend.comments.application.port.in.DeleteCommentUseCase;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.comments.domain.model.NewComment;
import com.fathy.alfred.backend.links.application.port.out.RequestApplyPort;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

/**
 * Makes an accepted request real (D10, D4): written through this Alfred's own services as the user - never a new Actor
 * value - with the other Alfred named in the text ("⇇ 83: …"), so the board's history says who asked. Undo takes it back
 * the way each kind allows: a card comment is struck through (its earlier text kept as a version), a brief comment is
 * resolved, a call note is deleted.
 */
@Component
public class LinksRequestApplier implements RequestApplyPort {

    private final StreamScope scope;
    private final ObjectProvider<GetCardUseCase> cards;
    private final ObjectProvider<CommentOnCardUseCase> cardComments;
    private final ObjectProvider<CommentExtrasUseCase> commentExtras;
    private final ObjectProvider<BriefCommentsUseCase> briefComments;
    private final ObjectProvider<CreateCommentUseCase> callNotes;
    private final ObjectProvider<DeleteCommentUseCase> deleteCallNotes;
    private final ObjectMapper json = new ObjectMapper();

    public LinksRequestApplier(StreamScope scope, ObjectProvider<GetCardUseCase> cards, ObjectProvider<CommentOnCardUseCase> cardComments,
                               ObjectProvider<CommentExtrasUseCase> commentExtras, ObjectProvider<BriefCommentsUseCase> briefComments,
                               ObjectProvider<CreateCommentUseCase> callNotes, ObjectProvider<DeleteCommentUseCase> deleteCallNotes) {
        this.scope = scope;
        this.cards = cards;
        this.cardComments = cardComments;
        this.commentExtras = commentExtras;
        this.briefComments = briefComments;
        this.callNotes = callNotes;
        this.deleteCallNotes = deleteCallNotes;
    }

    private ObjectProvider<com.fathy.alfred.backend.board.application.port.out.CycleCallsPort> cycleCalls;

    @org.springframework.beans.factory.annotation.Autowired
    void setCycleCalls(ObjectProvider<com.fathy.alfred.backend.board.application.port.out.CycleCallsPort> cycleCalls) {
        this.cycleCalls = cycleCalls;
    }

    /**
     * A note's target as this Alfred names it - "POST /refunds/7/approve", and the line when one was picked - never only
     * what the reader sent; the reader's label when the call is not found in its cycle.
     */
    String callLabel(String callId, String cycleId, JsonNode extra, String readerLabel) {
        String line = extra.path("lineText").asText("").strip();
        String lineHint = line.isEmpty() ? "" : " · line \"" + (line.length() > 60 ? line.substring(0, 60) + "…" : line) + "\"";
        com.fathy.alfred.backend.board.application.port.out.CycleCallsPort p = cycleCalls == null ? null : cycleCalls.getIfAvailable();
        if (p != null && cycleId != null) {
            try {
                for (var c : p.ofCycle(cycleId, 20_000)) {
                    if (callId.equals(c.callId())) {
                        return c.method() + " " + c.path() + lineHint;
                    }
                }
            } catch (RuntimeException e) {
                // the reader's label below
            }
        }
        return (readerLabel == null || readerLabel.isBlank() ? "a call" : readerLabel) + (readerLabel == null || readerLabel.isBlank() ? lineHint : "");
    }

    private JsonNode extra(LinkRequest r) {
        try {
            return json.readTree(r.extra() == null || r.extra().isBlank() ? "{}" : r.extra());
        } catch (IOException e) {
            return json.createObjectNode();
        }
    }

    @Override
    public Optional<String> allows(Stream stream, LinkRequest r) {
        switch (r.kind()) {
            case CARD_COMMENT, CARD_QUESTION -> {
                if (stream.kind() != StreamKind.BOARD) {
                    return Optional.empty();
                }
                GetCardUseCase g = cards.getIfAvailable();
                if (g == null) {
                    return Optional.empty();
                }
                Optional<CardDetail> card = g.get(r.target());
                if (card.isEmpty() || !scope.boardOfCard(r.target()).map(stream.target()::equals).orElse(false)) {
                    return Optional.empty();
                }
                return Optional.of("#" + card.get().card().number() + " " + card.get().card().title());
            }
            case BRIEF_COMMENT -> {
                return stream.kind() == StreamKind.BOARD && stream.target().equals(r.target())
                        ? Optional.of("the brief of " + (stream.targetName() == null ? r.target() : stream.targetName())) : Optional.empty();
            }
            case CALL_NOTE -> {
                JsonNode e = extra(r);
                String cycle = e.hasNonNull("cycleId") ? e.path("cycleId").asText() : null;
                if (scope.isRemote(r.target())) {
                    // a third Alfred's call: passed on only when its cycle is on what is streamed here (that Alfred decides the rest)
                    return cycle != null && scope.cycles(List.of(stream)).contains(cycle)
                            ? Optional.of(r.targetLabel() == null ? "a call" : r.targetLabel()) : Optional.empty();
                }
                return scope.streamOfCall(List.of(stream), r.target(), cycle, null).isPresent()
                        ? Optional.of(callLabel(r.target(), cycle != null ? cycle : stream.kind() == StreamKind.CYCLE ? stream.target() : null, e, null))
                        : Optional.empty();
            }
            default -> {
                return Optional.empty();
            }
        }
    }

    static String text(LinkRequest r, String author) {
        String who = author == null || author.isBlank() ? "another Alfred" : author;
        return r.kind() == RequestKind.CARD_QUESTION ? "⇇ **" + who + " asks:** " + r.text() : "⇇ **" + who + ":** " + r.text();
    }

    @Override
    public String apply(Stream stream, LinkRequest r, String authorName) {
        String text = text(r, authorName);
        switch (r.kind()) {
            case CARD_COMMENT, CARD_QUESTION -> {
                CommentOnCardUseCase c = cardComments.getObject();
                CommentOnCardUseCase.CommentOutcome out = c.comment(Actor.USER, r.target(),
                        new CommentOnCardUseCase.Comment(text, null, null, null, null));
                if (out.outcome() != CardChange.Outcome.OK || out.entry() == null) {
                    throw new IllegalStateException(out.message() == null ? "The card did not take the comment" : out.message());
                }
                return "card:" + r.target() + ":" + out.entry().id();
            }
            case BRIEF_COMMENT -> {
                JsonNode e = extra(r);
                String quote = e.hasNonNull("quote") ? e.path("quote").asText() : null;
                BriefCommentsUseCase.CommentOutcome out = briefComments.getObject().add(Actor.USER, r.target(),
                        new BriefCommentsUseCase.NewComment(quote, text, null, false, null, null));
                if (out.outcome() != CardChange.Outcome.OK || out.comment() == null) {
                    throw new IllegalStateException(out.message() == null ? "The brief did not take the comment" : out.message());
                }
                return "brief:" + r.target() + ":" + out.comment().id();
            }
            case CALL_NOTE -> {
                JsonNode e = extra(r);
                Comment saved = callNotes.getObject().create(new NewComment(r.target(), e.path("block").asText("response-body"),
                        e.path("lineIndex").asInt(0), e.path("lineText").asText(""), text));
                return "call:" + saved.id();
            }
            default -> throw new IllegalStateException("Not a request this Alfred takes");
        }
    }

    @Override
    public void undo(LinkRequest r) {
        String ref = r.resultRef();
        if (ref == null) {
            return;
        }
        String[] p = ref.split(":", 3);
        switch (p[0]) {
            case "card" -> {
                if (p.length == 3) {
                    CommentExtrasUseCase.Outcome out = commentExtras.getObject().editComment(Actor.USER, p[1], Long.parseLong(p[2]),
                            "~~" + text(r, r.author()) + "~~ *(taken back)*");
                    if (out.outcome() != CardChange.Outcome.OK) {
                        throw new IllegalStateException(out.message() == null ? "The comment could not be taken back" : out.message());
                    }
                }
            }
            case "brief" -> {
                if (p.length == 3) {
                    briefComments.getObject().resolve(Actor.USER, p[1], Long.parseLong(p[2]), true);
                }
            }
            case "call" -> deleteCallNotes.getObject().deleteById(ref.substring("call:".length()));
            default -> {
                // nothing made
            }
        }
    }
}
