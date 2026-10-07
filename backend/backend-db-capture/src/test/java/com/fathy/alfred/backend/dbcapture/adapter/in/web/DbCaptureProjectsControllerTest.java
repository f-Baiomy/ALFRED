package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(DbCaptureProjectsController.class)
class DbCaptureProjectsControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private ManageDbCaptureUseCase manage;

    @Test
    void theSwitchAnswersTheUpdatedList() throws Exception {
        when(manage.setEnabled("wallet-app", true)).thenReturn(List.of(new ProjectCaptureStatus("wallet-app", true, true, true, null)));
        mvc.perform(put("/db-capture/projects/wallet-app/enabled").contentType(MediaType.APPLICATION_JSON).content("{\"enabled\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].enabled").value(true));
    }

    @Test
    void theLogsSwitchAnswersTheUpdatedList_and409sWithInboundLoggingOff() throws Exception {
        when(manage.setLogsOn("wallet-app", true)).thenReturn(List.of(new ProjectCaptureStatus("wallet-app", false, true, true, null, true)));
        mvc.perform(put("/db-capture/projects/wallet-app/logs").contentType(MediaType.APPLICATION_JSON).content("{\"on\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].logsOn").value(true));
        when(manage.setLogsOn("core-service", true)).thenThrow(new InboundLoggingOffException("core-service"));
        mvc.perform(put("/db-capture/projects/core-service/logs").contentType(MediaType.APPLICATION_JSON).content("{\"on\":true}"))
                .andExpect(status().isConflict());
    }

    @Test
    void switchingOnWithInboundLoggingOffIs409_andBadSettingsAre400() throws Exception {
        when(manage.setEnabled("core-service", true)).thenThrow(new InboundLoggingOffException("core-service"));
        mvc.perform(put("/db-capture/projects/core-service/enabled").contentType(MediaType.APPLICATION_JSON).content("{\"enabled\":true}"))
                .andExpect(status().isConflict());
        when(manage.saveSettings(eq("wallet-app"), any())).thenThrow(new IllegalArgumentException("rowsPerResult must be between 1 and 1000000"));
        mvc.perform(put("/db-capture/projects/wallet-app/settings").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"rowsPerResult\":0,\"beforeImageTables\":[],\"outsideCallCapture\":true,\"expectedFingerprints\":[],\"ignorePatterns\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("rowsPerResult must be between 1 and 1000000"));
    }

    @org.junit.jupiter.api.Test
    void theRedisSwitchIs409WhileInboundLoggingIsOff() throws Exception {
        org.mockito.Mockito.when(manage.setRedisOn("wallet-app", true)).thenReturn(java.util.List.of());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/db-capture/projects/wallet-app/redis")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON).content("{\"on\":true}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
        org.mockito.Mockito.when(manage.setRedisOn("core-service", true))
                .thenThrow(new com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException("core-service"));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/db-capture/projects/core-service/redis")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON).content("{\"on\":true}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isConflict());
    }
}
