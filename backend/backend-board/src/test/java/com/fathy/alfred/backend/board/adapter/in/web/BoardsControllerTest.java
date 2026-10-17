package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.NewBoard;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.application.port.in.MoveCardHomeUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Board;
import com.fathy.alfred.backend.board.domain.model.BoardOutcome;
import com.fathy.alfred.backend.board.domain.model.BoardState;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** specs/027 contracts/board-rest.md: validation, outcomes to statuses, and the /board/boards/{id}/… aliases. */
@WebMvcTest({BoardsController.class, CycleBriefController.class})
class BoardsControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean ManageBoardsUseCase boards;
    @MockBean RelateCycleUseCase relations;
    @MockBean MoveCardHomeUseCase homes;
    @MockBean ManageBriefUseCase briefs;
    @MockBean ManageSpecFilesUseCase specs;
    @MockBean MarkChecklistUseCase checklist;

    private static final Instant AT = Instant.parse("2026-10-17T09:00:00Z");

    private static Board board(String id) {
        return new Board(id, "odeysys", "Login lockout", false, BoardState.OPEN, null, AT, AT, Actor.USER);
    }

    @Test
    void createReturns201WithTheBoard() throws Exception {
        when(boards.create(eq(Actor.USER), any())).thenReturn(new Result(BoardOutcome.OK, board("b-1"), null));

        mvc.perform(post("/board/boards").contentType("application/json")
                        .content("{\"project\":\" odeysys \",\"name\":\"Login lockout\",\"startRecording\":true}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.id").value("b-1"))
                .andExpect(jsonPath("$.name").value("Login lockout"));
        verify(boards).create(Actor.USER, new NewBoard("odeysys", "Login lockout", List.of(), null, true, null));
    }

    @Test
    void aBlankOrTooLongNameIs400() throws Exception {
        mvc.perform(post("/board/boards").contentType("application/json").content("{\"project\":\"odeysys\",\"name\":\" \"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/board/boards").contentType("application/json")
                        .content("{\"project\":\"odeysys\",\"name\":\"" + "x".repeat(Board.MAX_NAME + 1) + "\"}"))
                .andExpect(status().isBadRequest());
        verify(boards, never()).create(any(), any());
    }

    @Test
    void claudeWithoutAnAskIs403() throws Exception {
        when(boards.create(eq(Actor.CLAUDE), any())).thenReturn(Result.of(BoardOutcome.NOT_ASKED, "Open a board only when the user asks"));

        mvc.perform(post("/board/boards").header(BoardWeb.ACTOR_HEADER, "claude").contentType("application/json")
                        .content("{\"project\":\"odeysys\",\"name\":\"x\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error").value("not-asked"));
    }

    @Test
    void theDefaultBoardIsProtectedAs409() throws Exception {
        when(boards.delete(Actor.USER, "default:odeysys")).thenReturn(Result.of(BoardOutcome.DEFAULT_PROTECTED, "The default board stays"));

        mvc.perform(delete("/board/boards/default:odeysys"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("default-protected"));
    }

    @Test
    void deleteIs204() throws Exception {
        when(boards.delete(Actor.USER, "b-1")).thenReturn(new Result(BoardOutcome.OK, null, null));
        mvc.perform(delete("/board/boards/b-1")).andExpect(status().isNoContent());
    }

    @Test
    void anUnknownStateIs400() throws Exception {
        mvc.perform(patch("/board/boards/b-1").contentType("application/json").content("{\"state\":\"GONE\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(get("/board/boards").param("state", "GONE")).andExpect(status().isBadRequest());
        verify(boards, never()).update(any(), any(), any(), any());
    }

    @Test
    void listPassesStatesCaseInsensitively() throws Exception {
        when(boards.list("odeysys", Set.of(BoardState.OPEN, BoardState.DONE), null, 2000)).thenReturn(List.of());
        mvc.perform(get("/board/boards").param("project", "odeysys").param("state", "open", "Done"))
                .andExpect(status().isOk());
        verify(boards).list("odeysys", Set.of(BoardState.OPEN, BoardState.DONE), null, 2000);
    }

    @Test
    void anUnknownBoardIs404() throws Exception {
        when(boards.get("nope")).thenReturn(java.util.Optional.empty());
        mvc.perform(get("/board/boards/nope")).andExpect(status().isNotFound());
    }

    @Test
    void relateCycleAnswersWithTheBoard() throws Exception {
        when(relations.relateCycle(Actor.USER, "b-1", "c-9")).thenReturn(new Result(BoardOutcome.OK, board("b-1"), null));
        mvc.perform(put("/board/boards/b-1/cycles/c-9")).andExpect(status().isOk()).andExpect(jsonPath("$.id").value("b-1"));
    }

    @Test
    void aBlankHomeIs400() throws Exception {
        mvc.perform(put("/board/cards/k-1/home").contentType("application/json").content("{\"boardId\":\"\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void briefAnswersOnTheBoardsAlias() throws Exception {
        when(briefs.brief("b-1")).thenReturn(new CycleBrief("b-1", "Lock after 3 tries", AT, Actor.USER, false));
        mvc.perform(get("/board/boards/b-1/brief")).andExpect(status().isOk()).andExpect(jsonPath("$.text").value("Lock after 3 tries"));
        mvc.perform(get("/board/cycles/b-1/brief")).andExpect(status().isOk()).andExpect(jsonPath("$.text").value("Lock after 3 tries"));
    }
}
