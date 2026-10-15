package com.fathy.alfred.backend.board.adapter.in.web;

import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** specs/018: the requirement check over HTTP - the actor header, refusals as the board's other writes give them. */
@WebMvcTest(RequirementController.class)
class RequirementControllerTest {

    @Autowired
    MockMvc mvc;

    @MockBean RequirementUseCase requirements;

    @Test
    void claudesEvidenceIsSavedAsClaudes() throws Exception {
        ItemEvidence saved = new ItemEvidence("c-1", "spec.md", "k1", "odeysys", "POST /x/search",
                List.of(new EvidenceCheck(EvidenceCheck.Kind.REQUEST_SHAPE, "$.branch*", "list", null, null, null, null)), "pick 2",
                Actor.CLAUDE, Instant.parse("2026-10-15T09:00:00Z"));
        when(requirements.putEvidence(eq(Actor.CLAUDE), any())).thenReturn(new RequirementUseCase.EvidenceChange(CardChange.Outcome.OK, saved, null));

        mvc.perform(put("/board/cycles/c-1/evidence").header("X-Alfred-Actor", "claude").contentType("application/json").content("""
                        {"fileName":"spec.md","itemKey":"k1","project":"odeysys","endpoint":"POST /x/search","howTo":"pick 2",
                         "checks":[{"kind":"REQUEST_SHAPE","path":"$.branch*","shape":"list"}]}"""))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.checks[0].shape").value("list"));

        ArgumentCaptor<ItemEvidence> sent = ArgumentCaptor.forClass(ItemEvidence.class);
        verify(requirements).putEvidence(eq(Actor.CLAUDE), sent.capture());
        assertThat(sent.getValue().cycleId()).isEqualTo("c-1");
        assertThat(sent.getValue().checks()).singleElement().satisfies(c -> assertThat(c.path()).isEqualTo("$.branch*"));
    }

    @Test
    void aRefusalKeepsItsReason() throws Exception {
        when(requirements.putEvidence(eq(Actor.CLAUDE), any())).thenReturn(new RequirementUseCase.EvidenceChange(
                CardChange.Outcome.REFUSED_FOR_CLAUDE, null, "The user wrote this item's evidence - only the user changes it"));
        mvc.perform(put("/board/cycles/c-1/evidence").header("X-Alfred-Actor", "claude").contentType("application/json")
                        .content("{\"fileName\":\"spec.md\",\"itemKey\":\"k1\",\"endpoint\":\"UI\"}"))
                .andExpect(status().is4xxClientError());
        when(requirements.deleteEvidence(Actor.USER, "c-1", "spec.md", "k1"))
                .thenReturn(new RequirementUseCase.EvidenceChange(CardChange.Outcome.OK, null, null));
        mvc.perform(delete("/board/cycles/c-1/evidence").param("fileName", "spec.md").param("itemKey", "k1"))
                .andExpect(status().isNoContent());
    }

    @Test
    void theRequirementsListEveryItemWithItsVerdict() throws Exception {
        ItemVerdict v = new ItemVerdict("c-1", "spec.md", "k1", ItemVerdict.Verdict.MISSING, "call-1", "request $.branch* is a list - sent branchId: 948",
                new ItemVerdict.Counts(5, 0, 0, 0, 0), "card-1", Instant.parse("2026-10-15T09:00:00Z"));
        when(requirements.requirements("c-1")).thenReturn(new RequirementUseCase.Requirements("c-1",
                List.of(new RequirementUseCase.Requirement("spec.md", "k1", "Several branches", null, null, v, 41, "INBOX")),
                Map.of(ItemVerdict.Verdict.MISSING, 1)));

        mvc.perform(get("/board/cycles/c-1/requirements"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].verdict.verdict").value("MISSING"))
                .andExpect(jsonPath("$.items[0].cardNumber").value(41))
                .andExpect(jsonPath("$.counts.MISSING").value(1));
    }
}
