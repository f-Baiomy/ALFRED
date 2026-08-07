package com.alfred.pennyworth.application.service;

import com.alfred.pennyworth.application.port.out.CommentsStorePort;
import com.alfred.pennyworth.domain.model.Comment;
import com.alfred.pennyworth.domain.model.NewComment;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
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
        CommentsService service = new CommentsService(store);

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
        CommentsService service = new CommentsService(store);

        List<Comment> result = service.listByCallId("call-a");

        assertThat(result).extracting(Comment::id).containsExactly("c1");
    }

    @Test
    void delegatesDeleteToTheStore() {
        CommentsStorePort store = mock(CommentsStorePort.class);
        when(store.deleteById(eq("c1"))).thenReturn(true);
        CommentsService service = new CommentsService(store);

        assertThat(service.deleteById("c1")).isTrue();
        assertThat(service.deleteById("missing")).isFalse();
    }
}
