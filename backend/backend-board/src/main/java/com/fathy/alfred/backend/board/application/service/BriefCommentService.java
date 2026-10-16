package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BriefCommentsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BriefCommentStorePort;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BriefComment;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.List;
import java.util.Optional;

/**
 * Comments on a cycle's brief (specs/024). A reply always joins the thread of the comment it answers; a reply to a
 * resolved thread reopens it. Claude comments, replies, asks and suggests a rewording of a passage the brief holds as
 * written; the brief changes only when the user applies it, through the brief's own save.
 */
@Service
public class BriefCommentService implements BriefCommentsUseCase {

    static final String PASSAGE_CHANGED = "The passage is no longer in the brief as written - edit the brief yourself";

    private final BriefCommentStorePort store;
    private final ManageBriefUseCase briefs;
    private final BoardNotificationPort notifications;
    private final Clock clock;

    @Autowired
    public BriefCommentService(BriefCommentStorePort store, ManageBriefUseCase briefs, BoardNotificationPort notifications,
                               BoardChangeFeed feed) {
        this(store, briefs, notifications, feed, Clock.systemUTC());
    }

    BriefCommentService(BriefCommentStorePort store, ManageBriefUseCase briefs, BoardNotificationPort notifications,
                        BoardChangeFeed feed, Clock clock) {
        this.store = store;
        this.briefs = briefs;
        this.notifications = feed.feeding(notifications);
        this.clock = clock;
    }

    @Override
    public List<BriefComment> comments(String cycleId) {
        return store.briefComments(cycleId);
    }

    @Override
    public CommentOutcome add(Actor actor, String cycleId, NewComment c) {
        String text = c.text() == null ? "" : RichText.clean(c.text().strip());
        if (text.isBlank()) {
            return CommentOutcome.refused(CardChange.Outcome.INVALID, "A comment needs some text");
        }
        if (text.length() > MAX_TEXT) {
            return CommentOutcome.refused(CardChange.Outcome.INVALID, "A comment can be at most 16 KB");
        }
        boolean suggests = c.suggestTo() != null || c.suggestFrom() != null;
        if (actor != Actor.CLAUDE && (suggests || c.asks())) {
            return CommentOutcome.refused(CardChange.Outcome.INVALID, "Asking and suggesting a rewording are Claude's - edit the brief yourself");
        }
        String from = null;
        String to = null;
        if (suggests) {
            from = c.suggestFrom() == null ? "" : c.suggestFrom().strip();
            to = c.suggestTo() == null ? "" : RichText.clean(c.suggestTo().strip());
            if (from.isEmpty() || from.length() > MAX_QUOTE || to.length() > MAX_QUOTE) {
                return CommentOutcome.refused(CardChange.Outcome.INVALID, "A suggestion needs the passage (from) and its new wording (to), each at most 2000 characters");
            }
            if (!briefs.brief(cycleId).text().contains(from)) {
                return CommentOutcome.refused(CardChange.Outcome.INVALID, "The passage to reword is not in the brief as written: " + from);
            }
        }
        Long root = null;
        String quote = null;
        if (c.replyTo() != null) {
            Optional<BriefComment> parent = store.briefComment(c.replyTo()).filter(p -> p.cycleId().equals(cycleId));
            if (parent.isEmpty()) {
                return CommentOutcome.refused(CardChange.Outcome.NOT_FOUND, "No comment " + c.replyTo() + " on this brief");
            }
            root = parent.get().replyTo() != null ? parent.get().replyTo() : parent.get().id();
            BriefComment thread = store.briefComment(root).orElse(parent.get());
            if (thread.resolvedAt() != null) {
                store.resolveBriefComment(root, null, null);
            }
        } else if (c.quote() != null && !c.quote().isBlank()) {
            quote = c.quote().strip();
            if (quote.length() > MAX_QUOTE) {
                return CommentOutcome.refused(CardChange.Outcome.INVALID, "A quote can be at most 2000 characters");
            }
        }
        BriefComment comment = new BriefComment(0, cycleId, quote, actor, text, root, actor == Actor.CLAUDE && c.asks(), from, to,
                clock.instant(), null, null);
        long id = store.addBriefComment(comment);
        notifications.changed(null, cycleId, null, "brief-comments");
        return new CommentOutcome(CardChange.Outcome.OK, store.briefComment(id).orElse(comment), null, null);
    }

    @Override
    public CommentOutcome resolve(Actor actor, String cycleId, long id, boolean resolved) {
        if (actor == Actor.CLAUDE) {
            return CommentOutcome.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY);
        }
        Optional<BriefComment> c = thread(cycleId, id);
        if (c.isEmpty()) {
            return CommentOutcome.refused(CardChange.Outcome.NOT_FOUND, "No comment " + id + " on this brief");
        }
        store.resolveBriefComment(c.get().id(), resolved ? clock.instant() : null, resolved ? actor : null);
        notifications.changed(null, cycleId, null, "brief-comments");
        return new CommentOutcome(CardChange.Outcome.OK, store.briefComment(c.get().id()).orElse(null), null, null);
    }

    @Override
    public CommentOutcome apply(Actor actor, String cycleId, long id) {
        if (actor == Actor.CLAUDE) {
            return CommentOutcome.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.PROPOSE_ONLY);
        }
        Optional<BriefComment> c = store.briefComment(id).filter(x -> x.cycleId().equals(cycleId));
        if (c.isEmpty() || !c.get().hasSuggestion()) {
            return CommentOutcome.refused(CardChange.Outcome.NOT_FOUND, "No suggestion on comment " + id);
        }
        String from = c.get().suggestFrom();
        String to = c.get().suggestTo();
        String text = briefs.brief(cycleId).text();
        int at = text.indexOf(from);
        if (at < 0) {
            return CommentOutcome.refused(CardChange.Outcome.CONFLICT, PASSAGE_CHANGED);
        }
        ManageBriefUseCase.BriefOutcome saved = briefs.putBrief(actor, cycleId, text.substring(0, at) + to + text.substring(at + from.length()));
        if (saved.outcome() != CardChange.Outcome.OK) {
            return CommentOutcome.refused(saved.outcome(), saved.message());
        }
        store.clearBriefSuggestion(id);
        // the thread keeps pointing at its passage, now reworded
        Optional<BriefComment> root = thread(cycleId, id);
        root.filter(r -> r.quote() != null && r.quote().contains(from))
                .ifPresent(r -> store.requoteBriefComment(r.id(), r.quote().replace(from, to)));
        notifications.changed(null, cycleId, null, "brief-comments");
        return new CommentOutcome(CardChange.Outcome.OK, store.briefComment(id).orElse(null), saved.brief(), null);
    }

    @Override
    public CommentOutcome dismiss(Actor actor, String cycleId, long id) {
        if (actor == Actor.CLAUDE) {
            return CommentOutcome.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.PROPOSE_ONLY);
        }
        Optional<BriefComment> c = store.briefComment(id).filter(x -> x.cycleId().equals(cycleId));
        if (c.isEmpty() || !store.clearBriefSuggestion(id)) {
            return CommentOutcome.refused(CardChange.Outcome.NOT_FOUND, "No suggestion on comment " + id);
        }
        notifications.changed(null, cycleId, null, "brief-comments");
        return new CommentOutcome(CardChange.Outcome.OK, store.briefComment(id).orElse(null), null, null);
    }

    /** The first comment of the thread {@code id} belongs to, on this cycle. */
    private Optional<BriefComment> thread(String cycleId, long id) {
        return store.briefComment(id).filter(c -> c.cycleId().equals(cycleId))
                .flatMap(c -> c.replyTo() == null ? Optional.of(c) : store.briefComment(c.replyTo()));
    }
}
