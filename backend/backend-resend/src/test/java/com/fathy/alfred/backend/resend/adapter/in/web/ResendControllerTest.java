package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase.ResendOutcome;
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

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(ResendController.class)
@TestPropertySource(properties = "alfred.interception.max-answer-bytes=1048576")
class ResendControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ResendCallUseCase resendCallUseCase;

    private static final String VALID_BODY = """
            {"direction":"outbound","callId":"call-1"}
            """;

    @Test
    void aSuccessfulResendReturns200WithTheResult() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendOutcome.Success(
                new ResendResult("new-id", 200, 42L, List.of(new SessionValueUse("Cookie", "call-9")))));

        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.newCallId").value("new-id"))
                .andExpect(jsonPath("$.status").value(200))
                .andExpect(jsonPath("$.sessionValuesUsed[0].name").value("Cookie"))
                .andExpect(jsonPath("$.sessionValuesUsed[0].fromCallId").value("call-9"));
    }

    @Test
    void anUnknownCallReturns404() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendOutcome.NotFound());

        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("call-not-found"));
    }

    @Test
    void aStoppedReverseProxyReturns409() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendOutcome.ReverseProxyNotRunning());

        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error").value("reverse-proxy-not-running"));
    }

    @Test
    void aSendFailureReturns502WithItsMessage() throws Exception {
        when(resendCallUseCase.resend(any())).thenReturn(new ResendOutcome.SendFailed("connection reset"));

        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content(VALID_BODY))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.error").value("send-failed"))
                .andExpect(jsonPath("$.message").value("connection reset"));
    }

    @Test
    void aMissingDirectionReturns400() throws Exception {
        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content("""
                {"callId":"call-1"}
                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aBadDirectionReturns400() throws Exception {
        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content("""
                {"direction":"sideways","callId":"call-1"}
                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aUrlOverTheLimitReturns400() throws Exception {
        String longUrl = "https://example.com/" + "x".repeat(8200);
        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content("""
                {"direction":"outbound","callId":"call-1","edits":{"url":"%s"}}
                """.formatted(longUrl)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void tooManyHeaderEditsReturns400WithProblems() throws Exception {
        StringBuilder headers = new StringBuilder();
        for (int i = 0; i < 101; i++) {
            if (i > 0) headers.append(',');
            headers.append("\"X-H").append(i).append("\":\"v\"");
        }
        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content("""
                {"direction":"outbound","callId":"call-1","edits":{"headers":{%s}}}
                """.formatted(headers)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("invalid-request"))
                .andExpect(jsonPath("$.problems[0]").exists());
    }
}
