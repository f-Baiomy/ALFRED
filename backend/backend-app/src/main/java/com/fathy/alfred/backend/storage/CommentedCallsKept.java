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
 * page promises not to do. Read at most every 30 s - a limit trims a few calls at a time on the write path.
 */
@Component
class CommentedCallsKept {

    private final CommentsStorePort comments;
    private final StorageFiles files;
    // Looked up at first use, not injected: Relive needs the call stores, and the call stores ask this - a cycle.
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase> reliveProvider;
    private org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort> answersProvider;
    private com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase reliveCycles;
    private com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort storedAnswers;

    @org.springframework.beans.factory.annotation.Autowired
    void setProviders(org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase> relive,
                      org.springframework.beans.factory.ObjectProvider<com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort> answers) {
        this.reliveProvider = relive;
        this.answersProvider = answers;
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

    void refresh() {
        readAt = 0;
        referencedAt = 0;
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
