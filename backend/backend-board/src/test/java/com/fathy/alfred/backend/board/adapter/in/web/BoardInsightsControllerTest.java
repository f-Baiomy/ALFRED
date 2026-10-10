package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardChangesUseCase;
import com.fathy.alfred.backend.board.application.port.in.ProposeUseCase;
import com.fathy.alfred.backend.board.application.port.in.SearchCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SuggestMarkUseCase;
import com.fathy.alfred.backend.board.application.port.in.VerifyFixesUseCase;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(BoardInsightsController.class)
class BoardInsightsControllerTest {

    @Autowired MockMvc mvc;

    @MockBean SearchCardsUseCase search;
    @MockBean BoardChangesUseCase changes;
    @MockBean VerifyFixesUseCase verifyFixes;
    @MockBean ProposeUseCase proposals;
    @MockBean SuggestMarkUseCase suggestions;

    private static BoardChanges.Entry comment(long id, String text) {
        return new BoardChanges.Entry(new ActivityEntry(id, "k1", Actor.USER, ActivityKind.COMMENT, text, null, null,
                Instant.parse("2026-10-10T09:00:00Z")), "p", 3, "A card", CardStatus.TO_DO, null);
    }

    @Test
    void searchWithoutAProjectLooksAtEveryBoard() throws Exception {
        when(search.search(any())).thenReturn(new SearchCardsUseCase.SearchPage(List.of(), 0));

        mvc.perform(get("/board/search").param("status", "IN_PROGRESS,TO_DO").param("claudeTouched", "true")).andExpect(status().isOk());

        ArgumentCaptor<CardQuery> query = ArgumentCaptor.forClass(CardQuery.class);
        verify(search).search(query.capture());
        assertThat(query.getValue().allProjects()).isTrue();
        assertThat(query.getValue().claudeTouched()).isTrue();
        assertThat(query.getValue().statuses()).containsExactlyInAnyOrder(CardStatus.IN_PROGRESS, CardStatus.TO_DO);
    }

    @Test
    void aWaitAnswersAtOnceWhenSomethingChangedAlready() throws Exception {
        when(changes.changes(eq("5.0"), isNull(), isNull(), eq(Actor.USER), anyInt()))
                .thenReturn(new BoardChanges(List.of(comment(6, "hello")), List.of(), "6.0", false));

        MvcResult started = mvc.perform(get("/board/changes/wait").param("cursor", "5.0").param("actor", "user"))
                .andExpect(request().asyncStarted()).andReturn();

        mvc.perform(asyncDispatch(started)).andExpect(status().isOk()).andExpect(jsonPath("$.entries[0].text").value("hello"))
                .andExpect(jsonPath("$.entries[0].number").value(3)).andExpect(jsonPath("$.cursor").value("6.0"));
    }

    @Test
    void aWaitIsWokenByTheNextChange() throws Exception {
        BoardChanges none = new BoardChanges(List.of(), List.of(), "5.0", false);
        when(changes.changes(eq("5.0"), any(), any(), any(), anyInt())).thenReturn(none);
        ArgumentCaptor<Runnable> listener = ArgumentCaptor.forClass(Runnable.class);
        when(changes.onNextChange(listener.capture())).thenReturn(() -> { });

        MvcResult started = mvc.perform(get("/board/changes/wait").param("cursor", "5.0").param("timeoutSeconds", "20"))
                .andExpect(request().asyncStarted()).andReturn();
        verify(changes, timeout(2000)).onNextChange(any());

        when(changes.changes(eq("5.0"), any(), any(), any(), anyInt()))
                .thenReturn(new BoardChanges(List.of(comment(6, "moved it")), List.of(), "6.0", false));
        listener.getValue().run();

        mvc.perform(asyncDispatch(started)).andExpect(status().isOk()).andExpect(jsonPath("$.entries[0].text").value("moved it"));
    }

    @Test
    void anUnreadableCursorIsA400() throws Exception {
        when(changes.changes(eq("zz"), any(), any(), any(), anyInt())).thenThrow(new IllegalArgumentException("Unreadable cursor zz"));

        mvc.perform(get("/board/changes").param("cursor", "zz")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Unreadable cursor zz"));
    }

    @Test
    void aProposalCarriesWhoAsks() throws Exception {
        when(proposals.propose(eq(Actor.CLAUDE), eq("k1"), eq(CardStatus.CLOSED), eq(Resolution.FINE), eq("expected"), eq("")))
                .thenReturn(CardChange.refused(CardChange.Outcome.INVALID, "nope"));

        mvc.perform(put("/board/cards/k1/proposal").header("X-Alfred-Actor", "claude").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"CLOSED\",\"resolution\":\"FINE\",\"reason\":\"expected\",\"evidence\":\"\"}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.message").value("nope"));
    }
}
