package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(CallsWebhookController.class)
@TestPropertySource(properties = "alfred.webhook.secret=correct-secret")
class CallsWebhookControllerTest {

    private static final String CALL_JSON = """
            {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t"}
            """;

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ReceiveNewCallUseCase receiveNewCallUseCase;

    @MockBean
    private ReceivePreparedCallUseCase receivePreparedCallUseCase;

    @MockBean
    private ReceiveCompletedCallUseCase receiveCompletedCallUseCase;

    @Test
    void rejectsAMissingSecretWithUnauthorized() throws Exception {
        mockMvc.perform(post("/calls/webhook").contentType(MediaType.APPLICATION_JSON).content(CALL_JSON))
                .andExpect(status().isUnauthorized());

        verifyNoInteractions(receiveNewCallUseCase);
    }

    @Test
    void rejectsAWrongSecretWithUnauthorized() throws Exception {
        mockMvc.perform(post("/calls/webhook")
                        .header("X-Webhook-Secret", "wrong-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(CALL_JSON))
                .andExpect(status().isUnauthorized());

        verifyNoInteractions(receiveNewCallUseCase);
    }

    @Test
    void acceptsTheCorrectSecretAndDelegatesToTheUseCase() throws Exception {
        mockMvc.perform(post("/calls/webhook")
                        .header("X-Webhook-Secret", "correct-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(CALL_JSON))
                .andExpect(status().isNoContent());

        verify(receiveNewCallUseCase).receiveNewCall(any(CallRecord.class));
    }

    @Test
    void prepareRejectsAWrongSecretWithUnauthorized() throws Exception {
        mockMvc.perform(post("/calls/webhook/prepare")
                        .header("X-Webhook-Secret", "wrong-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(CALL_JSON))
                .andExpect(status().isUnauthorized());

        verifyNoInteractions(receivePreparedCallUseCase);
    }

    @Test
    void prepareReturnsTheAssignedIdWhenTheCallIsAllowed() throws Exception {
        when(receivePreparedCallUseCase.receivePreparedCall(any(CallRecord.class))).thenReturn(Optional.of("call-123"));

        mockMvc.perform(post("/calls/webhook/prepare")
                        .header("X-Webhook-Secret", "correct-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(CALL_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value("call-123"));
    }

    @Test
    void prepareReturnsNoContentWhenTheFilterRejectsTheCall() throws Exception {
        when(receivePreparedCallUseCase.receivePreparedCall(any(CallRecord.class))).thenReturn(Optional.empty());

        mockMvc.perform(post("/calls/webhook/prepare")
                        .header("X-Webhook-Secret", "correct-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(CALL_JSON))
                .andExpect(status().isNoContent());
    }

    @Test
    void completeRejectsAWrongSecretWithUnauthorized() throws Exception {
        mockMvc.perform(post("/calls/webhook/call-123/complete")
                        .header("X-Webhook-Secret", "wrong-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());

        verifyNoInteractions(receiveCompletedCallUseCase);
    }

    @Test
    void completeDelegatesWithTheIdFromThePathAndReturnsNoContentWhenFound() throws Exception {
        when(receiveCompletedCallUseCase.receiveCompletedCall(eq("call-123"), any(), isNull(), any())).thenReturn(true);

        mockMvc.perform(post("/calls/webhook/call-123/complete")
                        .header("X-Webhook-Secret", "correct-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"response":{"status":200,"headers":{},"body":"ok"},"duration_ms":42.0}
                                """))
                .andExpect(status().isNoContent());

        verify(receiveCompletedCallUseCase).receiveCompletedCall(eq("call-123"), any(), isNull(), eq(42.0));
    }

    @Test
    void completeReturnsNotFoundWhenTheUseCaseReportsNoMatchingCall() throws Exception {
        when(receiveCompletedCallUseCase.receiveCompletedCall(eq("missing"), any(), any(), any())).thenReturn(false);

        mockMvc.perform(post("/calls/webhook/missing/complete")
                        .header("X-Webhook-Secret", "correct-secret")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"error":"timeout"}
                                """))
                .andExpect(status().isNotFound());
    }
}
