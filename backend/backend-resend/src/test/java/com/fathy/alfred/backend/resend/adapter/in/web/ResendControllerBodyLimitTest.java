package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** A separate test class because the tiny configured body limit (via @TestPropertySource, class-scoped) would otherwise apply to every other case in ResendControllerTest too. */
@WebMvcTest(ResendController.class)
@TestPropertySource(properties = "alfred.interception.max-answer-bytes=10")
class ResendControllerBodyLimitTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ResendCallUseCase resendCallUseCase;

    @Test
    void aBodyOverTheConfiguredLimitIs400() throws Exception {
        String body = "{\"direction\":\"outbound\",\"callId\":\"orig-1\",\"edits\":{\"body\":\"12345678901\"}}";

        mockMvc.perform(post("/resend")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(resendCallUseCase);
    }
}
