package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.AgentStatusUseCase;
import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.CallBadgesUseCase;
import com.fathy.alfred.backend.board.application.port.in.CloseCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CommentOnCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.DeleteCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.GetCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.LinkCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ListActivityUseCase;
import com.fathy.alfred.backend.board.application.port.in.ListClosedReasonsUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.QueryCardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.QuickAddCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.ReopenCardUseCase;
import com.fathy.alfred.backend.board.application.port.in.SetReasonUseCase;
import com.fathy.alfred.backend.board.application.port.in.UndoCloseUseCase;
import com.fathy.alfred.backend.board.application.port.in.UpdateCardUseCase;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.CardsPage;
import com.fathy.alfred.backend.board.domain.model.Scope;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(BoardController.class)
class BoardControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean CreateCardUseCase create;
    @MockBean QuickAddCardUseCase quickAdd;
    @MockBean UpdateCardUseCase update;
    @MockBean MoveCardUseCase move;
    @MockBean DeleteCardUseCase delete;
    @MockBean QueryCardsUseCase query;
    @MockBean GetCardUseCase getCard;
    @MockBean CloseCardUseCase close;
    @MockBean ReopenCardUseCase reopen;
    @MockBean SetReasonUseCase reason;
    @MockBean UndoCloseUseCase undo;
    @MockBean BulkCardsUseCase bulk;
    @MockBean LinkCardUseCase links;
    @MockBean CommentOnCardUseCase comments;
    @MockBean ListActivityUseCase activity;
    @MockBean ListClosedReasonsUseCase closedReasons;
    @MockBean CallBadgesUseCase badges;
    @MockBean AgentStatusUseCase agent;

    private static CardDetail detail() {
        Instant t = Instant.parse("2026-10-10T09:00:00Z");
        return new CardDetail(new Card("id1", "p", 7, CardKind.BUG, "Discount", "d", CardStatus.INBOX, null, null, Set.of(), Scope.NOT_DECIDED,
                Actor.USER, null, false, null, t, t, Actor.USER), 0, List.of(), null);
    }

    @Test
    void aCreatedCardIsFlatJsonWith201() throws Exception {
        when(create.create(eq(Actor.USER), any())).thenReturn(CardChange.ok(detail()));

        mvc.perform(post("/board/cards").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"project\":\"p\",\"kind\":\"BUG\",\"title\":\"Discount\",\"links\":[{\"type\":\"call\",\"ref\":\"in:a\",\"label\":\"POST\"}]}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.number").value(7))
                .andExpect(jsonPath("$.title").value("Discount"));
    }

    @Test
    void invalidBodiesAre400() throws Exception {
        mvc.perform(post("/board/cards").contentType(MediaType.APPLICATION_JSON).content("{\"kind\":\"BUG\",\"title\":\"\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/board/cards").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"BUG\",\"title\":\"" + "x".repeat(301) + "\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/board/cards").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"BUG\",\"title\":\"t\",\"links\":[{\"type\":\"user\",\"ref\":\"x\",\"label\":\"y\"}]}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void claudeIsRecognisedByItsHeaderAndARefusalIs409WithTheMessage() throws Exception {
        when(move.move(Actor.CLAUDE, "id1", CardStatus.DONE))
                .thenReturn(CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, ClaudeRules.USER_ONLY));

        mvc.perform(post("/board/cards/id1/move").header("X-Alfred-Actor", "claude").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"DONE\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("refused-for-claude"))
                .andExpect(jsonPath("$.message").value(ClaudeRules.USER_ONLY));
    }

    @Test
    void unknownCardsAre404() throws Exception {
        when(getCard.get("nope")).thenReturn(Optional.empty());
        mvc.perform(get("/board/cards/nope")).andExpect(status().isNotFound());
        when(activity.activity(eq("nope"), anyInt(), anyInt())).thenReturn(Optional.empty());
        mvc.perform(get("/board/cards/nope/activity")).andExpect(status().isNotFound());
    }

    @Test
    void theListPassesItsFiltersAndTheQueryClampsTheLimit() throws Exception {
        when(query.query(any())).thenReturn(new CardsPage(List.of(), 0, new CardsPage.Progress(0, 0, 0)));

        mvc.perform(get("/board/cards").param("project", "p").param("kind", "bug,task").param("status", "INBOX").param("limit", "99999"))
                .andExpect(status().isOk());

        ArgumentCaptor<CardQuery> captor = ArgumentCaptor.forClass(CardQuery.class);
        verify(query).query(captor.capture());
        assertThat(captor.getValue().kinds()).containsExactlyInAnyOrder(CardKind.BUG, CardKind.TASK);
        assertThat(captor.getValue().limit()).isEqualTo(CardQuery.MAX_LIMIT);
        mvc.perform(get("/board/cards").param("kind", "dragon")).andExpect(status().isBadRequest());
    }

    @Test
    void bulkTakesAtMostTwoHundredCards() throws Exception {
        String ids = String.join(",", java.util.Collections.nCopies(201, "\"x\""));
        mvc.perform(post("/board/cards/bulk").contentType(MediaType.APPLICATION_JSON).content("{\"ids\":[" + ids + "],\"action\":\"FINE\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aCommentIs201WithTheEntry() throws Exception {
        when(comments.comment(eq(Actor.USER), eq("id1"), any())).thenReturn(new CommentOnCardUseCase.CommentOutcome(CardChange.Outcome.OK,
                new ActivityEntry(5, "id1", Actor.USER, ActivityKind.COMMENT, "hi", null, null, Instant.now()), null));

        mvc.perform(post("/board/cards/id1/comments").contentType(MediaType.APPLICATION_JSON).content("{\"text\":\"hi\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value(5));
    }

    @Test
    void tooManyBadgeIdsAre400() throws Exception {
        when(badges.badgesOfCalls(any())).thenThrow(new IllegalArgumentException("At most 100 call ids per request"));
        mvc.perform(get("/board/call-badges").param("callIds", "a,b")).andExpect(status().isBadRequest());
    }
}
