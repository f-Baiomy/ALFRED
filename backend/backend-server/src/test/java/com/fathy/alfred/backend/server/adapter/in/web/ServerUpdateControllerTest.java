package com.fathy.alfred.backend.server.adapter.in.web;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.in.UpdateUseCase;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;
import com.fathy.alfred.backend.server.domain.model.UpdateJob;
import com.fathy.alfred.backend.server.domain.model.UpdateMode;
import com.fathy.alfred.backend.server.domain.model.UpdateStatus;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.Set;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ServerUpdateController.class)
class ServerUpdateControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private UpdateUseCase updates;
    @MockBean
    private EditAccessUseCase editAccess;

    private static final UpdateStatus AVAILABLE = new UpdateStatus(UpdateMode.CHECK, RuntimeMode.NATIVE, "linux-x64", "1.4.0",
            "1.5.0", true, Instant.parse("2026-10-08T12:00:00Z"), "https://feed", "notes", "2026-10-08", "https://dl/x.run",
            241, "02:00-04:00", true, UpdateJob.idle(), "");

    @BeforeEach
    void localOnly() {
        when(editAccess.access(anyString(), any())).thenAnswer(inv -> AccessRule.parse("local")
                .decide(inv.getArgument(0), inv.getArgument(1), Set.of(), RuntimeMode.NATIVE));
        when(updates.status()).thenReturn(AVAILABLE);
        when(updates.check()).thenReturn(AVAILABLE);
    }

    @Test
    void statusAndCheckAreOpenToEveryoneWhoCanOpenTheUi() throws Exception {
        mvc.perform(get("/server/update").with(r -> { r.setRemoteAddr("203.0.113.9"); return r; }))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.available").value(true))
                .andExpect(jsonPath("$.latestVersion").value("1.5.0"))
                .andExpect(jsonPath("$.job.state").value("IDLE"));
        mvc.perform(post("/server/update/check").with(r -> { r.setRemoteAddr("203.0.113.9"); return r; }))
                .andExpect(status().isOk());
        verify(updates).check();
    }

    @Test
    void installIsAWriteLocalYesForeignNo() throws Exception {
        mvc.perform(post("/server/update/install")).andExpect(status().isAccepted());
        verify(updates).install(null);
        mvc.perform(post("/server/update/install").with(r -> { r.setRemoteAddr("203.0.113.9"); return r; }))
                .andExpect(status().isForbidden());
        verify(updates, never()).check();
    }

    @Test
    void aRefusedInstallIs409WithTheReason() throws Exception {
        doThrow(new IllegalStateException("Alfred 1.5.0 is up to date")).when(updates).install(null);
        mvc.perform(post("/server/update/install")).andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value("Alfred 1.5.0 is up to date"));
    }

    @Test
    void aChosenVersionIsPassedOn() throws Exception {
        mvc.perform(post("/server/update/install").contentType("application/json").content("{\"version\":\"1.4.5\"}"))
                .andExpect(status().isAccepted());
        verify(updates).install("1.4.5");
    }

    @Test
    void pauseAndCancelAreWritesLocalYesForeignNo() throws Exception {
        mvc.perform(post("/server/update/pause")).andExpect(status().isAccepted());
        mvc.perform(post("/server/update/cancel")).andExpect(status().isAccepted());
        verify(updates).pause();
        verify(updates).cancel();
        mvc.perform(post("/server/update/pause").with(r -> { r.setRemoteAddr("203.0.113.9"); return r; }))
                .andExpect(status().isForbidden());
        mvc.perform(post("/server/update/cancel").with(r -> { r.setRemoteAddr("203.0.113.9"); return r; }))
                .andExpect(status().isForbidden());
        doThrow(new IllegalStateException("No update is downloading")).when(updates).pause();
        mvc.perform(post("/server/update/pause")).andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value("No update is downloading"));
    }
}
