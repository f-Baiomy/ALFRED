package com.alfred.pennyworth.calls.adapter.in.web;

import com.alfred.pennyworth.calls.application.port.in.ReceiveNewCallUseCase;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
}
