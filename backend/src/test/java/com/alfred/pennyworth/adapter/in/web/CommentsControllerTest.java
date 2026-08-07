package com.alfred.pennyworth.adapter.in.web;

import com.alfred.pennyworth.application.port.in.CreateCommentUseCase;
import com.alfred.pennyworth.application.port.in.DeleteCommentUseCase;
import com.alfred.pennyworth.application.port.in.ListCommentsUseCase;
import com.alfred.pennyworth.domain.model.Comment;
import com.alfred.pennyworth.domain.model.NewComment;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(CommentsController.class)
class CommentsControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ListCommentsUseCase listCommentsUseCase;
    @MockBean
    private CreateCommentUseCase createCommentUseCase;
    @MockBean
    private DeleteCommentUseCase deleteCommentUseCase;

    @Test
    void rejectsACommentWithABlankCallId() throws Exception {
        mockMvc.perform(post("/comments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callId":"","block":"request-body","lineIndex":0,"lineText":"{","comment":"note"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void acceptsAValidCommentAndDelegatesToTheUseCase() throws Exception {
        Comment created = new Comment("c1", "call-1", "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
        when(createCommentUseCase.create(any())).thenReturn(created);

        mockMvc.perform(post("/comments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"callId":"call-1","block":"request-body","lineIndex":0,"lineText":"{","comment":"note"}
                                """))
                .andExpect(status().isOk());

        verify(createCommentUseCase).create(new NewComment("call-1", "request-body", 0, "{", "note"));
    }

    @Test
    void returnsNotFoundWhenDeletingAMissingComment() throws Exception {
        when(deleteCommentUseCase.deleteById(eq("missing"))).thenReturn(false);

        mockMvc.perform(delete("/comments/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsNoContentWhenDeletingAnExistingComment() throws Exception {
        when(deleteCommentUseCase.deleteById(eq("c1"))).thenReturn(true);

        mockMvc.perform(delete("/comments/c1"))
                .andExpect(status().isNoContent());
    }
}
