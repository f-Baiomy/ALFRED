package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.BoardStageUseCase;
import com.fathy.alfred.backend.board.domain.model.BoardStage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Optional;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The stage's JSON carries the structured step next to the unchanged text (specs/032 D1). */
@WebMvcTest(BoardStageController.class)
class BoardStageControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean BoardStageUseCase stages;

    @Test
    void theStageCarriesItsStepNextToTheText() throws Exception {
        BoardStage st = BoardStage.of("AB#59851", new BoardStage.Counts(true, 3, 4, 0, 0, 0, 0, 0, 0, 0));
        when(stages.stage("b1")).thenReturn(Optional.of(st));
        mvc.perform(get("/board/boards/b1/stage"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stage").value("TRIAGE"))
                .andExpect(jsonPath("$.next").value(st.next()))
                .andExpect(jsonPath("$.step.kind").value("CLAUDE"))
                .andExpect(jsonPath("$.step.skill").value("alfred-triage"))
                .andExpect(jsonPath("$.step.command").value("/alfred-triage AB#59851"))
                .andExpect(jsonPath("$.step.count").value(4));
    }

    @Test
    void anUnknownBoardIsNotFound() throws Exception {
        when(stages.stage("nope")).thenReturn(Optional.empty());
        mvc.perform(get("/board/boards/nope/stage")).andExpect(status().isNotFound());
    }
}
