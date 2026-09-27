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
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
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

    private static Map<String, Object> stateStub() {
        return Map.of("variables", Map.of(), "fallbacks", Map.of(), "updatedAt", Map.of(), "sources", Map.of(),
                "secrets", java.util.List.of(), "activeEnvironment", "Default", "environments", java.util.List.of("Default"));
    }

    @Test
    void getReturnsTheCurrentState() throws Exception {
        when(variables.get()).thenReturn(stateStub());

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
        when(variables.promote(eq("token"), eq("NEW"), eq("r-1"), eq("Login token"))).thenReturn(stateStub());

        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"token\",\"value\":\"NEW\",\"ruleId\":\"r-1\",\"ruleName\":\"Login token\"}"))
                .andExpect(status().isOk());
        verify(variables).promote("token", "NEW", "r-1", "Login token");
    }

    @Test
    void promotedWithoutRuleInfoPassesNulls() throws Exception {
        when(variables.promote(eq("token"), eq("NEW"), isNull(), isNull())).thenReturn(stateStub());

        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"token\",\"value\":\"NEW\"}"))
                .andExpect(status().isOk());
        verify(variables).promote("token", "NEW", null, null);
    }

    @Test
    void promotedRejectsABadName() throws Exception {
        when(variables.promote(eq("this.x"), eq("v"), isNull(), isNull()))
                .thenThrow(new IllegalArgumentException("Variable name needs letters"));

        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"this.x\",\"value\":\"v\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void promotedRejectsANonStringName() throws Exception {
        mockMvc.perform(post("/settings/variables/promoted")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":42,\"value\":\"v\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putByNameUpsertsThroughTheService() throws Exception {
        when(variables.upsert(eq("token"), eq("NEW"))).thenReturn(stateStub());

        mockMvc.perform(put("/settings/variables/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"value\":\"NEW\"}"))
                .andExpect(status().isOk());
        verify(variables).upsert("token", "NEW");
    }

    @Test
    void putByNameRejectsANonStringValue() throws Exception {
        mockMvc.perform(put("/settings/variables/token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"value\":42}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putByNameRejectsABadName() throws Exception {
        when(variables.upsert(eq("1bad"), eq("v")))
                .thenThrow(new IllegalArgumentException("Variable name needs letters"));

        mockMvc.perform(put("/settings/variables/1bad")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"value\":\"v\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void deleteByNameRemovesThroughTheService() throws Exception {
        when(variables.remove(eq("token"), isNull())).thenReturn(stateStub());

        mockMvc.perform(delete("/settings/variables/token"))
                .andExpect(status().isOk());
        verify(variables).remove("token", null);
    }

    @Test
    void deleteByNameWithFallbackQueryParam() throws Exception {
        when(variables.remove(eq("token"), eq("fb"))).thenReturn(stateStub());

        mockMvc.perform(delete("/settings/variables/token").param("fallback", "fb"))
                .andExpect(status().isOk());
        verify(variables).remove("token", "fb");
    }

    @Test
    void deleteByNameRejectsABadName() throws Exception {
        when(variables.remove(eq("this.x"), isNull()))
                .thenThrow(new IllegalArgumentException("Variable name needs letters"));

        mockMvc.perform(delete("/settings/variables/this.x"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putSecretMarksAName() throws Exception {
        when(variables.setSecret(eq("apiKey"), eq(true))).thenReturn(stateStub());

        mockMvc.perform(put("/settings/variables/apiKey/secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"secret\":true}"))
                .andExpect(status().isOk());
        verify(variables).setSecret("apiKey", true);
    }

    @Test
    void putSecretRejectsANonBooleanBody() throws Exception {
        mockMvc.perform(put("/settings/variables/apiKey/secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"secret\":\"yes\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void postEnvironmentsCreatesOne() throws Exception {
        when(variables.createEnvironment(eq("Staging"), isNull())).thenReturn(stateStub());

        mockMvc.perform(post("/settings/variables/environments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Staging\"}"))
                .andExpect(status().isOk());
        verify(variables).createEnvironment("Staging", null);
    }

    @Test
    void postEnvironmentsCanCopyFromAnother() throws Exception {
        when(variables.createEnvironment(eq("Staging"), eq("Default"))).thenReturn(stateStub());

        mockMvc.perform(post("/settings/variables/environments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Staging\",\"copyFrom\":\"Default\"}"))
                .andExpect(status().isOk());
        verify(variables).createEnvironment("Staging", "Default");
    }

    @Test
    void postEnvironmentsRejectsADuplicateName() throws Exception {
        when(variables.createEnvironment(eq("Default"), isNull()))
                .thenThrow(new IllegalArgumentException("An environment named \"Default\" already exists."));

        mockMvc.perform(post("/settings/variables/environments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Default\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putActiveEnvironmentSwitchesIt() throws Exception {
        when(variables.activateEnvironment(eq("Staging"))).thenReturn(stateStub());

        mockMvc.perform(put("/settings/variables/environments/active")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"Staging\"}"))
                .andExpect(status().isOk());
        verify(variables).activateEnvironment("Staging");
    }

    @Test
    void deleteEnvironmentRemovesIt() throws Exception {
        when(variables.deleteEnvironment(eq("Staging"))).thenReturn(stateStub());

        mockMvc.perform(delete("/settings/variables/environments/Staging"))
                .andExpect(status().isOk());
        verify(variables).deleteEnvironment("Staging");
    }

    @Test
    void deleteEnvironmentRejectsTheActiveOne() throws Exception {
        when(variables.deleteEnvironment(eq("Default")))
                .thenThrow(new IllegalArgumentException("Cannot delete the active environment."));

        mockMvc.perform(delete("/settings/variables/environments/Default"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void getEnvironmentExportReturnsNameVariablesAndFallbacks() throws Exception {
        when(variables.exportEnvironment(eq("Default")))
                .thenReturn(Map.of("name", "Default", "variables", Map.of(), "fallbacks", Map.of()));

        mockMvc.perform(get("/settings/variables/environments/Default/export"))
                .andExpect(status().isOk());
    }

    @Test
    void postImportMergesIntoAnEnvironment() throws Exception {
        when(variables.importEnvironment(eq("Staging"), eq(Map.of("a", "1")), eq(null), eq("MERGE")))
                .thenReturn(stateStub());

        mockMvc.perform(post("/settings/variables/import")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"environment\":\"Staging\",\"variables\":{\"a\":\"1\"},\"mode\":\"MERGE\"}"))
                .andExpect(status().isOk());
        verify(variables).importEnvironment("Staging", Map.of("a", "1"), null, "MERGE");
    }

    @Test
    void postImportRejectsAMissingEnvironment() throws Exception {
        mockMvc.perform(post("/settings/variables/import")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"variables\":{},\"mode\":\"MERGE\"}"))
                .andExpect(status().isBadRequest());
    }
}
