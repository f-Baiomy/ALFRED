package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

/**
 * "Never delete calls that have a comment or are used by a Relive cycle or a stored answer", while the storage page's
 * rule is on (the default): both call stores ask this before trimming, and every clean-up, age rule and the disk
 * guard skip these calls too. A Relive step and a stored answer each keep their own full copy (FrozenCall, the
 * answer's body), so deleting the call would not break them - but their "open original" would lead nowhere, which the
 * page promises not to do. Read at most every 30 s - a limit trims a few calls at a time on the write path. Live calls
 * mentioned on the task board are kept the same way (specs/014-task-board research R3): the board says when that set
 * changes, so a newly mentioned call is kept at once rather than after the cache runs out.
 */
@Component
class CommentedCallsKept {

    private final CommentsStorePort comments;
    private final StorageFiles files;
    // Looked up at first use, not injected: Relive needs the call stores, and the call stores ask this - a cycle.
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase> reliveProvider;
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort> answersProvider;
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.board.application.port.in.ListMentionedCallIdsUseCase> boardProvider;
    private com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase reliveCycles;
    private com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort storedAnswers;

    @org.springframework.beans.factory.annotation.Autowired
    void setProviders(org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase> relive,
                      org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort> answers,
                      org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.board.application.port.in.ListMentionedCallIdsUseCase> board) {
        this.reliveProvider = relive;
        this.answersProvider = answers;
        this.boardProvider = board;
    }

    private com.fathy.alfred.backend.board.application.port.in.ListMentionedCallIdsUseCase board;

    /** For tests: the board's mentioned calls directly. */
    void setBoard(com.fathy.alfred.backend.board.application.port.in.ListMentionedCallIdsUseCase board) {
        this.board = board;
    }

    /** For tests: the sources directly. */
    void setReferences(com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase reliveCycles,
                       com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort storedAnswers) {
        this.reliveCycles = reliveCycles;
        this.storedAnswers = storedAnswers;
    }
    private volatile Set<String> cache = Set.of();
    private volatile long readAt;

    CommentedCallsKept(CommentsStorePort comments, StorageFiles files) {
        this.comments = comments;
        this.files = files;
    }

    Set<String> kept() {
        long now = System.currentTimeMillis();
        if (now - readAt > 30_000) {
            readAt = now;
            if (!files.loadBudget().rulesOrDefault().keepCommentedOrDefault()) {
                cache = Set.of();
            } else {
                Set<String> ids = new HashSet<>();
                try {
                    for (Comment c : comments.findAll()) {
                        if (c.callId() != null) {
                            ids.add(c.callId());
                        }
                    }
                } catch (RuntimeException e) {
                    // comments unreadable: trim as before rather than not at all
                }
                ids.addAll(referenced());
                ids.addAll(boardMentioned());
                cache = Set.copyOf(ids);
            }
        }
        return cache;
    }

    private volatile Set<String> referencedCache = Set.of();
    private volatile long referencedAt;

    /**
     * The calls Relive steps were recorded from and stored answers were copied from - read at most every 5 minutes:
     * it opens every Relive cycle, and a new step or answer is rare next to the calls arriving.
     */
    Set<String> referenced() {
        long now = System.currentTimeMillis();
        if (now - referencedAt > 300_000) {
            referencedAt = now;
            referencedCache = Set.copyOf(readReferenced());
        }
        return referencedCache;
    }

    private Set<String> readReferenced() {
        if (reliveCycles == null && reliveProvider != null) {
            reliveCycles = reliveProvider.getIfAvailable();
        }
        if (storedAnswers == null && answersProvider != null) {
            storedAnswers = answersProvider.getIfAvailable();
        }
        Set<String> ids = new HashSet<>();
        try {
            if (reliveCycles != null) {
                for (var summary : reliveCycles.list()) {
                    reliveCycles.get(summary.id()).ifPresent(cycle -> cycle.steps().forEach(step -> {
                        if (step.source() != null && step.source().callId() != null) {
                            ids.add(step.source().callId());
                        }
                    }));
                }
            }
        } catch (RuntimeException e) {
            // Relive unreadable: its copies stand on their own anyway
        }
        try {
            if (storedAnswers != null) {
                storedAnswers.listMeta().forEach(a -> {
                    if (a.sourceCallId() != null) {
                        ids.add(a.sourceCallId());
                    }
                });
            }
        } catch (RuntimeException e) {
            // as above
        }
        return ids;
    }

    /** One indexed read of board.db - cheap enough to repeat with the 30 s cache, unlike the Relive walk above. */
    private Set<String> boardMentioned() {
        if (board == null && boardProvider != null) {
            board = boardProvider.getIfAvailable();
        }
        try {
            return board == null ? Set.of() : board.mentionedLiveCallIds();
        } catch (RuntimeException e) {
            return Set.of(); // board unreadable: trim as before rather than not at all
        }
    }

    /** The board's mentioned calls changed: re-read on the next ask instead of up to 30 s later. */
    void boardChanged() {
        readAt = 0;
    }

    void refresh() {
        readAt = 0;
        referencedAt = 0;
    }

    /** The board tells this when the live calls it mentions change (MentionedCallsChangedPort). */
    @Component
    static class BoardMentions implements com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort {
        private final CommentedCallsKept kept;

        BoardMentions(CommentedCallsKept kept) {
            this.kept = kept;
        }

        @Override
        public void mentionedCallsChanged() {
            kept.boardChanged();
        }
    }

    @Component
    static class Inbound implements com.fathy.alfred.backend.internalcalls.application.port.out.KeptCallIdsPort {
        private final CommentedCallsKept kept;

        Inbound(CommentedCallsKept kept) {
            this.kept = kept;
        }

        @Override
        public Set<String> keptCallIds() {
            return kept.kept();
        }
    }

    @Component
    static class Outbound implements com.fathy.alfred.backend.calls.application.port.out.KeptCallIdsPort {
        private final CommentedCallsKept kept;

        Outbound(CommentedCallsKept kept) {
            this.kept = kept;
        }

        @Override
        public Set<String> keptCallIds() {
            return kept.kept();
        }
    }
}
