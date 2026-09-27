package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.application.port.in.ManageGlobalVariablesUseCase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(GlobalVariablesController.class)
class GlobalVariablesControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ManageGlobalVariablesUseCase variables;

    @Test
    void getReturnsTheCurrentState() throws Exception {
        when(variables.get()).thenReturn(Map.of("variables", Map.of(), "fallbacks", Map.of()));

        mockMvc.perform(get("/settings/variables"))
                .andExpect(status().isOk());
    }

    @Test
    void putRejectsAnInvalidState() throws Exception {
        when(variables.save(org.mockito.ArgumentMatchers.anyMap()))
                .thenThrow(new IllegalArgumentException("Variables need valid names and text values"));

        mockMvc.perform(put("/settings/variables")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"variables\":{\"1bad\":\"v\"}}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void promotedMergesOneValueThroughTheService() throws Exception {
        when(variables.promote(eq("token"), eq("NEW")))
                .thenReturn(Map.of("variables", Map.of("token", "NEW"), "fallbacks", Map.of()));

        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"token\",\"value\":\"NEW\"}"))
                .andExpect(status().isOk());
        verify(variables).promote("token", "NEW");
    }

    @Test
    void promotedRejectsABadName() throws Exception {
        when(variables.promote(eq("this.x"), eq("v")))
                .thenThrow(new IllegalArgumentException("Variable name needs letters"));

        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"this.x\",\"value\":\"v\"}"))
                .andExpect(status().isBadRequest());
    }
}
