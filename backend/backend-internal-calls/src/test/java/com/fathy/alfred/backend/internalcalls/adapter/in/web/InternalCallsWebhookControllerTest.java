package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.application.port.in.ReceiveCompletedCallUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceivePreparedCallUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.ReceiveWsMessagesUseCase;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** The completion webhook's boundary rules: a bounded call identity (FR-015) and no 2xx for a call not stored (FR-014). */
class InternalCallsWebhookControllerTest {

    private final ReceivePreparedCallUseCase prepared = mock(ReceivePreparedCallUseCase.class);
    private final ReceiveCompletedCallUseCase completed = mock(ReceiveCompletedCallUseCase.class);
    private MockMvc mvc;

    /** Stands in for backend-platform's GlobalExceptionHandler, which answers any unhandled exception with 500. */
    @RestControllerAdvice
    static class Unhandled {
        @ExceptionHandler(IllegalStateException.class)
        @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
        void fail() {
        }
    }

    @BeforeEach
    void setUp() {
        InternalCallsWebhookController controller = new InternalCallsWebhookController(prepared, completed, mock(ReceiveWsMessagesUseCase.class));
        ReflectionTestUtils.setField(controller, "webhookSecret", "s3cret");
        mvc = MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(new Unhandled()).build();
    }

    private static String completion(String url, String method) {
        return "{\"response\":{\"status\":200,\"headers\":{},\"body\":\"\"},\"duration_ms\":1.0,"
                + "\"call\":{\"url\":\"" + url + "\",\"method\":\"" + method + "\",\"timestamp\":\"2026-10-09T00:00:00Z\",\"service_name\":\"odeysys\"}}";
    }

    @Test
    void anOversizedCallIdentityIsRefusedAndNeverStored() throws Exception {
        mvc.perform(post("/internal-calls/webhook/c1/complete").header("X-Webhook-Secret", "s3cret")
                        .contentType(MediaType.APPLICATION_JSON).content(completion("http://h/" + "a".repeat(9000), "GET")))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/internal-calls/webhook/c1/complete").header("X-Webhook-Secret", "s3cret")
                        .contentType(MediaType.APPLICATION_JSON).content(completion("http://h/x", "M".repeat(17))))
                .andExpect(status().isBadRequest());
        verify(completed, never()).receiveCompletedCall(anyString(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void aBoundedIdentityReachesTheUseCase() throws Exception {
        when(completed.receiveCompletedCall(eq("c1"), any(), any(), any(), any(), any(), any())).thenReturn(true);
        mvc.perform(post("/internal-calls/webhook/c1/complete").header("X-Webhook-Secret", "s3cret")
                        .contentType(MediaType.APPLICATION_JSON).content(completion("http://h/x", "OPTIONS")))
                .andExpect(status().isNoContent());
    }

    @Test
    void aCallTheStoreCouldNotWriteIsAServerErrorSoTheProxyRetries() throws Exception {
        when(completed.receiveCompletedCall(eq("c1"), any(), any(), any(), any(), any(), any()))
                .thenThrow(new IllegalStateException("Failed to persist write"));
        mvc.perform(post("/internal-calls/webhook/c1/complete").header("X-Webhook-Secret", "s3cret")
                        .contentType(MediaType.APPLICATION_JSON).content(completion("http://h/x", "GET")))
                .andExpect(status().isInternalServerError());
    }
}
