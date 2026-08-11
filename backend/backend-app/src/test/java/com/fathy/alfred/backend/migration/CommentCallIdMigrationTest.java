package com.fathy.alfred.backend.migration;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CommentCallIdMigrationTest {

    private final CallLogPort callLogPort = mock(CallLogPort.class);
    private final SessionCycleMetadataStorePort sessionCycleMetadataStorePort = mock(SessionCycleMetadataStorePort.class);
    private final CapturedCallsStorePort capturedCallsStorePort = mock(CapturedCallsStorePort.class);
    private final CommentsStorePort commentsStorePort = mock(CommentsStorePort.class);
    private final CommentCallIdMigration migration = new CommentCallIdMigration(
            callLogPort, sessionCycleMetadataStorePort, capturedCallsStorePort, commentsStorePort);

    private static CallRecord call(String id, String timestamp, String method, String originalUrl) {
        return new CallRecord(id, originalUrl, "https://real.example/x", method, null, timestamp, 1.0, null, null);
    }

    private static Comment comment(String id, String callId) {
        return new Comment(id, callId, "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
    }

    /** Mirrors the frontend's callKey(): `c_` + (timestamp|method|original_url) with non-alphanumerics replaced by `_`. */
    private static String legacyKey(String timestamp, String method, String originalUrl) {
        String raw = timestamp + "|" + method + "|" + originalUrl;
        return "c_" + raw.replaceAll("[^a-zA-Z0-9]", "_");
    }

    @Test
    void remapsACommentFromTheLegacyContentHashToTheCallsRealId() {
        String legacyCallId = legacyKey("2026-01-01T00_00_00Z", "GET", "https_a_com_proxy_x");
        CallRecord existingCall = call("real-id-1", "2026-01-01T00_00_00Z", "GET", "https_a_com_proxy_x");
        when(callLogPort.readAll()).thenReturn(List.of(existingCall));
        when(sessionCycleMetadataStorePort.findAll()).thenReturn(List.of());
        when(commentsStorePort.findAll()).thenReturn(List.of(comment("comment-1", legacyCallId)));

        migration.run(null);

        ArgumentCaptor<List<Comment>> captor = ArgumentCaptor.forClass(List.class);
        verify(commentsStorePort).replaceAll(captor.capture());
        assertThat(captor.getValue()).extracting(Comment::callId).containsExactly("real-id-1");
    }

    @Test
    void leavesACommentAlreadyOnARealIdUnchangedAndSkipsTheWrite() {
        when(callLogPort.readAll()).thenReturn(List.of(call("real-id-1", "t", "GET", "url")));
        when(sessionCycleMetadataStorePort.findAll()).thenReturn(List.of());
        when(commentsStorePort.findAll()).thenReturn(List.of(comment("comment-1", "real-id-1")));

        migration.run(null);

        verify(commentsStorePort, never()).replaceAll(any());
    }

    @Test
    void leavesAnOrphanedCommentAloneWhenNoCallMatchesItsLegacyKey() {
        when(callLogPort.readAll()).thenReturn(List.of());
        when(sessionCycleMetadataStorePort.findAll()).thenReturn(List.of());
        when(commentsStorePort.findAll()).thenReturn(List.of(comment("comment-1", "some-unmatched-legacy-key")));

        migration.run(null);

        verify(commentsStorePort, never()).replaceAll(any());
    }

    @Test
    void fallsBackToACapturedCallsIdWhenTheCallIsNotInTheMainLog() {
        String legacyCallId = legacyKey("t1", "POST", "orig-url");
        CallRecord capturedOnlyCall = call("captured-real-id", "t1", "POST", "orig-url");
        SessionCycle cycle = new SessionCycle("cycle-1", "Repro", "t", null, SessionCycleStatus.PAUSED);
        when(callLogPort.readAll()).thenReturn(List.of());
        when(sessionCycleMetadataStorePort.findAll()).thenReturn(List.of(cycle));
        when(capturedCallsStorePort.findAllByCycle("cycle-1"))
                .thenReturn(List.of(new CapturedCall("wrapper-id", "t", capturedOnlyCall)));
        when(commentsStorePort.findAll()).thenReturn(List.of(comment("comment-1", legacyCallId)));

        migration.run(null);

        ArgumentCaptor<List<Comment>> captor = ArgumentCaptor.forClass(List.class);
        verify(commentsStorePort).replaceAll(captor.capture());
        assertThat(captor.getValue()).extracting(Comment::callId).containsExactly("captured-real-id");
    }

    @Test
    void prefersTheMainLogsIdWhenTheSameLegacyKeyExistsInBothPlaces() {
        String legacyCallId = legacyKey("t1", "GET", "orig-url");
        CallRecord inMainLog = call("main-log-id", "t1", "GET", "orig-url");
        CallRecord inCycle = call("captured-id", "t1", "GET", "orig-url");
        SessionCycle cycle = new SessionCycle("cycle-1", "Repro", "t", null, SessionCycleStatus.PAUSED);
        when(callLogPort.readAll()).thenReturn(List.of(inMainLog));
        when(sessionCycleMetadataStorePort.findAll()).thenReturn(List.of(cycle));
        when(capturedCallsStorePort.findAllByCycle("cycle-1"))
                .thenReturn(List.of(new CapturedCall("wrapper-id", "t", inCycle)));
        when(commentsStorePort.findAll()).thenReturn(List.of(comment("comment-1", legacyCallId)));

        migration.run(null);

        ArgumentCaptor<List<Comment>> captor = ArgumentCaptor.forClass(List.class);
        verify(commentsStorePort).replaceAll(captor.capture());
        assertThat(captor.getValue()).extracting(Comment::callId).containsExactly("main-log-id");
    }
}
