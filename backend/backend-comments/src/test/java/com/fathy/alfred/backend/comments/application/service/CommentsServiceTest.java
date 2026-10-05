package com.fathy.alfred.backend.comments.application.service;

import com.fathy.alfred.backend.comments.application.port.out.CommentNotificationPort;
import com.fathy.alfred.backend.comments.application.port.out.CommentsStorePort;
import com.fathy.alfred.backend.comments.domain.model.Comment;
import com.fathy.alfred.backend.comments.domain.model.NewComment;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CommentsServiceTest {

    private static Comment comment(String id, String callId) {
        return new Comment(id, callId, "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
    }

    @Test
    void assignsIdAndTimestampOnCreate() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        CommentsService service = new CommentsService(store, mock(CommentNotificationPort.class));

        Comment created = service.create(new NewComment("call-1", "request-body", 2, "line", "looks wrong"));

        assertThat(created.id()).isNotBlank();
        assertThat(created.createdAt()).isNotBlank();
        assertThat(created.callId()).isEqualTo("call-1");
        assertThat(created.comment()).isEqualTo("looks wrong");

        ArgumentCaptor<Comment> captor = ArgumentCaptor.forClass(Comment.class);
        verify(store).save(captor.capture());
        assertThat(captor.getValue()).isEqualTo(created);
    }

    @Test
    void filtersByCallIdWhenListing() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        when(store.findAll()).thenReturn(List.of(comment("c1", "call-a"), comment("c2", "call-b")));
        CommentsService service = new CommentsService(store, mock(CommentNotificationPort.class));

        List<Comment> result = service.listByCallId("call-a");

        assertThat(result).extracting(Comment::id).containsExactly("c1");
    }

    @Test
    void delegatesDeleteToTheStore() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        when(store.deleteById(eq("c1"))).thenReturn(true);
        CommentsService service = new CommentsService(store, mock(CommentNotificationPort.class));

        assertThat(service.deleteById("c1")).isTrue();
        assertThat(service.deleteById("missing")).isFalse();
    }

    @Test
    void createAndDeleteSignalTheCallWhoseCommentsChanged() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        CommentNotificationPort notifications = mock(CommentNotificationPort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        when(store.findAll()).thenReturn(List.of(comment("c1", "call-a")));
        when(store.deleteById(eq("c1"))).thenReturn(true);
        CommentsService service = new CommentsService(store, notifications);

        service.create(new NewComment("call-z", "request-body", 0, "{", "note"));
        verify(notifications).notifyCommentsChanged("call-z");

        service.deleteById("c1");
        verify(notifications).notifyCommentsChanged("call-a");
    }

    @Test
    void aDeleteThatRemovedNothingSignalsNothing() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        CommentNotificationPort notifications = mock(CommentNotificationPort.class);
        when(store.findAll()).thenReturn(List.of());
        CommentsService service = new CommentsService(store, notifications);

        assertThat(service.deleteById("missing")).isFalse();
        verify(notifications, never()).notifyCommentsChanged(any());
    }

    @Test
    void countsCommentsPerCallAndBlockForTheAskedCallsOnly() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        when(store.findAll()).thenReturn(List.of(
                new Comment("c1", "call-a", "request-body", 0, "{", "x", "t"),
                new Comment("c2", "call-a", "request-body", 3, "y", "x", "t"),
                new Comment("c3", "call-a", "call", 0, "", "note", "t"),
                new Comment("c4", "call-b", "response-headers", 1, "z", "x", "t"),
                new Comment("c5", "call-c", "response-body", 1, "z", "x", "t")));
        CommentsService service = new CommentsService(store, mock(CommentNotificationPort.class));

        var counts = service.countByCallIds(List.of("call-a", "call-b", "call-none"));

        assertThat(counts).containsOnlyKeys("call-a", "call-b");
        assertThat(counts.get("call-a").total()).isEqualTo(3);
        assertThat(counts.get("call-a").byBlock()).containsEntry("request-body", 2).containsEntry("call", 1);
        assertThat(counts.get("call-b").byBlock()).containsOnly(java.util.Map.entry("response-headers", 1));
    }
}
