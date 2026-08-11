package com.fathy.alfred.backend.migration;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * One-time (but safely re-run-on-every-startup) remap of comments.json's callId from the legacy
 * content hash (timestamp+method+original_url - what the frontend's callKey() used before calls
 * had a real id) to each call's now-real id. Lives here in backend-app rather than in
 * backend-comments or backend-calls because it needs both - comments must not depend on calls,
 * and calls must not depend on comments (see HexagonalArchitectureTest), so the composition root
 * is the only place allowed to know about both at once.
 *
 * <p>Runs via CallLogPort.readAll()/CapturedCallsStorePort.findAllByCycle(), which is also where
 * FileCallLogAdapter/JsonFileCapturedCallsStoreAdapter backfill a real id onto any pre-existing
 * line that predates the id field - so simply reading everything here is enough to trigger that
 * backfill before this migration computes its mapping.
 *
 * <p><b>Known limitation:</b> if the same legacy-content call was independently backfilled with
 * different ids in more than one place (e.g. it aged out of RECENT_CALLS.log's ring buffer but a
 * copy lives on in more than one session-cycle's captured-calls file), only one of those ids wins
 * per legacy key - comments on the others stay on their old callId. This only affects comments
 * added before this feature existed, on a call that no longer has a single canonical copy.
 */
@Component
public class CommentCallIdMigration implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(CommentCallIdMigration.class);

    private final CallLogPort callLogPort;
    private final SessionCycleMetadataStorePort sessionCycleMetadataStorePort;
    private final CapturedCallsStorePort capturedCallsStorePort;
    private final CommentsStorePort commentsStorePort;

    public CommentCallIdMigration(
            CallLogPort callLogPort,
            SessionCycleMetadataStorePort sessionCycleMetadataStorePort,
            CapturedCallsStorePort capturedCallsStorePort,
            CommentsStorePort commentsStorePort
    ) {
        this.callLogPort = callLogPort;
        this.sessionCycleMetadataStorePort = sessionCycleMetadataStorePort;
        this.capturedCallsStorePort = capturedCallsStorePort;
        this.commentsStorePort = commentsStorePort;
    }

    @Override
    public void run(ApplicationArguments args) {
        Map<String, String> legacyKeyToId = new HashMap<>();
        // Main log first - preferred source when a call exists in both places, since it's where
        // most comments get added from (the Live Calls dashboard).
        for (CallRecord call : callLogPort.readAll()) {
            legacyKeyToId.putIfAbsent(legacyContentKey(call), call.id());
        }
        for (SessionCycle cycle : sessionCycleMetadataStorePort.findAll()) {
            for (CapturedCall captured : capturedCallsStorePort.findAllByCycle(cycle.id())) {
                legacyKeyToId.putIfAbsent(legacyContentKey(captured.call()), captured.call().id());
            }
        }

        List<Comment> existing = commentsStorePort.findAll();
        int migrated = 0;
        List<Comment> updated = existing.stream().map(comment -> {
            String realId = legacyKeyToId.get(comment.callId());
            if (realId == null || realId.equals(comment.callId())) {
                return comment;
            }
            return new Comment(comment.id(), realId, comment.block(), comment.lineIndex(), comment.lineText(), comment.comment(), comment.createdAt());
        }).toList();

        for (int i = 0; i < existing.size(); i++) {
            if (!existing.get(i).callId().equals(updated.get(i).callId())) {
                migrated++;
            }
        }

        if (migrated > 0) {
            commentsStorePort.replaceAll(updated);
            log.info("Migrated {} comment(s) from legacy content-hash callId to real call id", migrated);
        }
    }

    /** Mirrors the frontend's shared/utils/call-utils.ts callKey() exactly - the identifier comments were keyed by before calls had a real id. */
    private static String legacyContentKey(CallRecord call) {
        String raw = Objects.toString(call.timestamp(), "") + "|" + Objects.toString(call.method(), "") + "|" + Objects.toString(call.originalUrl(), "");
        return "c_" + raw.replaceAll("[^a-zA-Z0-9]", "_");
    }
}
