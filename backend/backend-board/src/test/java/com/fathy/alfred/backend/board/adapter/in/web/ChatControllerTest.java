package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** /board/chats: bounds, who is asking, and the refusal shape. The rules themselves are ChatServiceTest's. */
@WebMvcTest(ChatController.class)
class ChatControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean
    ChatUseCase chats;

    private static ChatMessage message(long id) {
        return new ChatMessage(id, new ChatKey("p", "c-1"), null, ChatMessage.Author.USER, ChatMessage.Kind.TEXT, "hi", ChatMessage.State.WAITING,
                false, false, "typed", List.of(), null, null, Map.of(), null, null, null, false, Instant.parse("2026-10-15T10:00:00Z"), null);
    }

    @Test
    void thePageLimitIsClampedAndAMessageReadsWithItsScope() throws Exception {
        when(chats.page(any(), any(), eq(100))).thenReturn(new ChatUseCase.Page(List.of(message(4)), true, Map.of()));
        mvc.perform(get("/board/chats/c-1/messages").param("project", "p").param("limit", "5000"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.messages[0].scope").value("c-1"))
                .andExpect(jsonPath("$.messages[0].project").value("p"))
                .andExpect(jsonPath("$.more").value(true));
        verify(chats).page(eq(new ChatKey("p", "c-1")), isNull(), eq(100));
        when(chats.page(any(), any(), eq(1))).thenReturn(new ChatUseCase.Page(List.of(), false, Map.of()));
        mvc.perform(get("/board/chats/project/messages").param("project", "p").param("limit", "-3")).andExpect(status().isOk());
        verify(chats).page(eq(new ChatKey("p", "")), isNull(), eq(1));
    }

    @Test
    void aTextOver64KbIsRefusedBeforeTheService() throws Exception {
        String big = "x".repeat(ChatMessage.MAX_TEXT + 1);
        mvc.perform(post("/board/chats/c-1/messages").param("project", "p").contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\":\"" + big + "\"}")).andExpect(status().isBadRequest());
        verify(chats, never()).post(any(), any(), any());
    }

    @Test
    void theActorHeaderReachesTheServiceAndARefusalKeepsTheBoardsShape() throws Exception {
        when(chats.post(eq(Actor.CLAUDE), any(), any())).thenReturn(ChatUseCase.Result.no(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Claude answers"));
        mvc.perform(post("/board/chats/c-1/messages").param("project", "p").header("X-Alfred-Actor", "claude")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"hi\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("refused-for-claude"))
                .andExpect(jsonPath("$.message").value("Claude answers"));
    }

    @Test
    void aTakeWithoutTheChatIdIsInvalidAndATakeByAnotherChatIsAConflict() throws Exception {
        mvc.perform(post("/board/chats/messages/4/take").contentType(MediaType.APPLICATION_JSON).content("{}")).andExpect(status().isBadRequest());
        when(chats.take(eq(Actor.CLAUDE), anyLong(), eq("chat-b"), eq("c-1")))
                .thenReturn(ChatUseCase.Result.no(CardChange.Outcome.CONFLICT, "Another chat holds this cycle"));
        mvc.perform(post("/board/chats/messages/4/take").header("X-Alfred-Actor", "claude").contentType(MediaType.APPLICATION_JSON)
                .content("{\"chatId\":\"chat-b\",\"cycleId\":\"c-1\"}")).andExpect(status().isConflict());
    }

    @Test
    void anUnknownMessageIs404() throws Exception {
        when(chats.message(9)).thenReturn(java.util.Optional.empty());
        mvc.perform(get("/board/chats/messages/9")).andExpect(status().isNotFound());
    }

    @Test
    void settingsOutsideTheirBoundsAreRefused() throws Exception {
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/board/chats/c-1/settings").param("project", "p")
                .contentType(MediaType.APPLICATION_JSON).content("{\"autoN\":5,\"digestGapMin\":30,\"watching\":false}"))
                .andExpect(status().isBadRequest());
        verify(chats, never()).putSettings(any(), any());
    }
}
