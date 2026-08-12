package com.fathy.alfred.backend.settings.adapter.in.web;

import com.fathy.alfred.backend.settings.application.port.in.GetCallFilterSettingsUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageBlacklistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.ManageWhitelistUseCase;
import com.fathy.alfred.backend.settings.application.port.in.SetFilterModeUseCase;
import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(CallFilterSettingsController.class)
class CallFilterSettingsControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private GetCallFilterSettingsUseCase getCallFilterSettingsUseCase;
    @MockBean
    private SetFilterModeUseCase setFilterModeUseCase;
    @MockBean
    private ManageWhitelistUseCase manageWhitelistUseCase;
    @MockBean
    private ManageBlacklistUseCase manageBlacklistUseCase;

    @Test
    void getReturnsTheCurrentSettings() throws Exception {
        when(getCallFilterSettingsUseCase.getSettings()).thenReturn(CallFilterSettings.defaults());

        mockMvc.perform(get("/settings/call-filtering"))
                .andExpect(status().isOk());
    }

    @Test
    void putModeRejectsAMissingMode() throws Exception {
        mockMvc.perform(put("/settings/call-filtering/mode")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void putModeDelegatesToTheUseCase() throws Exception {
        when(setFilterModeUseCase.setMode(FilterMode.ACCEPT_ONLY)).thenReturn(CallFilterSettings.defaults());

        mockMvc.perform(put("/settings/call-filtering/mode")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"mode":"ACCEPT_ONLY"}
                                """))
                .andExpect(status().isOk());

        verify(setFilterModeUseCase).setMode(FilterMode.ACCEPT_ONLY);
    }

    @Test
    void postWhitelistRejectsABlankHost() throws Exception {
        mockMvc.perform(post("/settings/call-filtering/whitelist")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"host":""}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void postWhitelistDelegatesToTheUseCase() throws Exception {
        when(manageWhitelistUseCase.addWhitelistUrl("allowed.com")).thenReturn(CallFilterSettings.defaults());

        mockMvc.perform(post("/settings/call-filtering/whitelist")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"host":"allowed.com"}
                                """))
                .andExpect(status().isOk());

        verify(manageWhitelistUseCase).addWhitelistUrl("allowed.com");
    }

    @Test
    void patchWhitelistTogglesTheGivenEntry() throws Exception {
        when(manageWhitelistUseCase.toggleWhitelistUrl(eq("r1"), eq(false))).thenReturn(CallFilterSettings.defaults());

        mockMvc.perform(patch("/settings/call-filtering/whitelist/r1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"enabled":false}
                                """))
                .andExpect(status().isOk());

        verify(manageWhitelistUseCase).toggleWhitelistUrl("r1", false);
    }

    @Test
    void deleteWhitelistRemovesTheGivenEntry() throws Exception {
        when(manageWhitelistUseCase.removeWhitelistUrl("r1")).thenReturn(
                new CallFilterSettings(FilterMode.ACCEPT_ONLY, List.of(), List.of()));

        mockMvc.perform(delete("/settings/call-filtering/whitelist/r1"))
                .andExpect(status().isOk());

        verify(manageWhitelistUseCase).removeWhitelistUrl("r1");
    }

    @Test
    void postBlacklistDelegatesToTheUseCase() throws Exception {
        when(manageBlacklistUseCase.addBlacklistUrl("blocked.com")).thenReturn(CallFilterSettings.defaults());

        mockMvc.perform(post("/settings/call-filtering/blacklist")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"host":"blocked.com"}
                                """))
                .andExpect(status().isOk());

        verify(manageBlacklistUseCase).addBlacklistUrl("blocked.com");
    }

    @Test
    void deleteBlacklistRemovesTheGivenEntry() throws Exception {
        when(manageBlacklistUseCase.removeBlacklistUrl("b1")).thenReturn(
                new CallFilterSettings(FilterMode.ACCEPT_ALL, List.of(), List.of(new UrlRule("b2", "other.com", true))));

        mockMvc.perform(delete("/settings/call-filtering/blacklist/b1"))
                .andExpect(status().isOk());

        verify(manageBlacklistUseCase).removeBlacklistUrl("b1");
    }
}
