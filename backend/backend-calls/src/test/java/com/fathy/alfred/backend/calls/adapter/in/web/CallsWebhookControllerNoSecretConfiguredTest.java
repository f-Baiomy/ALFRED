package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.ReceiveNewCallUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** When no secret is configured (the default - alfred.webhook.secret unset), the webhook is open, matching CorsConfig's "permissive default, tighten via config" precedent. */
@WebMvcTest(CallsWebhookController.class)
class CallsWebhookControllerNoSecretConfiguredTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ReceiveNewCallUseCase receiveNewCallUseCase;

    @Test
    void acceptsAnyRequestWhenNoSecretIsConfigured() throws Exception {
        mockMvc.perform(post("/calls/webhook")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t"}
                                """))
                .andExpect(status().isNoContent());

        verify(receiveNewCallUseCase).receiveNewCall(any(CallRecord.class));
    }
}
