package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;
import com.fathy.alfred.backend.resend.domain.model.SessionValueUse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ResendController.class)
class ResendControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ResendCallUseCase resendCallUseCase;

    @Test
    void doneMapsTo200WithTheResultBody() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendCallUseCase.ResendOutcome.Done(
                new ResendResult("new-1", 201, 42, List.of(new SessionValueUse("cookie", "c-9")))));

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"outbound\",\"callId\":\"orig-1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.newCallId").value("new-1"))
                .andExpect(jsonPath("$.status").value(201))
                .andExpect(jsonPath("$.durationMs").value(42))
                .andExpect(jsonPath("$.sessionValuesUsed[0].name").value("cookie"))
                .andExpect(jsonPath("$.sessionValuesUsed[0].fromCallId").value("c-9"));
    }

    @Test
    void notFoundMapsTo404() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendCallUseCase.ResendOutcome.NotFound());

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"outbound\",\"callId\":\"orig-1\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("call-not-found"));
    }

    @Test
    void reverseProxyNotRunningMapsTo409() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendCallUseCase.ResendOutcome.ReverseProxyNotRunning());

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"inbound\",\"callId\":\"orig-1\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("reverse-proxy-not-running"));
    }

    @Test
    void sendFailedMapsTo502() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendCallUseCase.ResendOutcome.SendFailed("boom"));

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"outbound\",\"callId\":\"orig-1\"}"))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.error").value("send-failed"))
                .andExpect(jsonPath("$.message").value("boom"));
    }

    @Test
    void aMissingCallIdIs400() throws Exception {
        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"outbound\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(resendCallUseCase);
    }

    @Test
    void anInvalidDirectionIs400() throws Exception {
        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"sideways\",\"callId\":\"orig-1\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(resendCallUseCase);
    }

    @Test
    void moreThan100HeaderEditsIs400() throws Exception {
        Map<String, String> headers = new java.util.LinkedHashMap<>();
        for (int i = 0; i < 101; i++) {
            headers.put("X-H" + i, "v");
        }
        String headersJson = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(headers);

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"direction\":\"outbound\",\"callId\":\"orig-1\",\"edits\":{\"headers\":" + headersJson + "}}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(resendCallUseCase);
    }

    @Test
    void aHeaderValueOver8KbIs400WithTheProblemText() throws Exception {
        String longValue = "x".repeat(8193);
        String body = "{\"direction\":\"outbound\",\"callId\":\"orig-1\",\"edits\":{\"headers\":{\"X-A\":\"" + longValue + "\"}}}";

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.problems[0]").value("header X-A is over 8 KB"));

        verifyNoInteractions(resendCallUseCase);
    }

}
