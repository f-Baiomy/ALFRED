package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Kept apart from ResendControllerTest: builds a body around the real 10 MB default cap. */
@WebMvcTest(ResendController.class)
@TestPropertySource(properties = "alfred.interception.max-answer-bytes=10485760")
class ResendControllerBodyLimitTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ResendCallUseCase resendCallUseCase;

    @Test
    void aBodyOverTheCapReturns400() throws Exception {
        String oversized = "x".repeat(10_485_761);
        String content = "{\"direction\":\"outbound\",\"callId\":\"call-1\",\"edits\":{\"body\":\"" + oversized + "\"}}";

        mockMvc.perform(post("/resend").contentType(MediaType.APPLICATION_JSON).content(content))
                .andExpect(status().isBadRequest());
    }
}
