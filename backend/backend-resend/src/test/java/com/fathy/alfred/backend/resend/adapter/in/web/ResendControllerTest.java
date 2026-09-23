package com.fathy.alfred.backend.resend.adapter.in.web;

import com.fathy.alfred.backend.resend.application.port.in.RecordResendUseCase;
import com.fathy.alfred.backend.resend.application.port.out.CallExistsPort;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ResendControllerTest {

    private CallExistsPort callExistsPort;
    private RecordResendUseCase recordResendUseCase;
    private ResendController controller;

    @BeforeEach
    void setUp() {
        callExistsPort = mock(CallExistsPort.class);
        recordResendUseCase = mock(RecordResendUseCase.class);
        controller = new ResendController(callExistsPort, recordResendUseCase);
    }

    @Test
    void getResendMetadataReturns404WhenCallDoesNotExist() {
        when(callExistsPort.exists("missing")).thenReturn(false);

        ResponseEntity<Map<String, Object>> response = controller.getResendMetadata("missing");

        assertThat(response.getStatusCode().value()).isEqualTo(404);
    }

    @Test
    void getResendMetadataReturns200WithCallIdWhenCallExists() {
        when(callExistsPort.exists("c1")).thenReturn(true);

        ResponseEntity<Map<String, Object>> response = controller.getResendMetadata("c1");

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).containsEntry("call_id", "c1");
        assertThat(response.getBody()).containsEntry("resend_available", true);
    }

    @Test
    void recordResendOutcomeReturns400WhenAnyFieldIsMissing() {
        ResponseEntity<Void> response = controller.recordResendOutcome(Map.of("resend_request_id", "r1"));

        assertThat(response.getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void recordResendOutcomeDelegatesToTheUseCaseAndReturns204() {
        Map<String, String> payload = Map.of(
                "resend_request_id", "r1",
                "original_call_id", "orig",
                "new_call_id", "new1"
        );

        ResponseEntity<Void> response = controller.recordResendOutcome(payload);

        assertThat(response.getStatusCode().value()).isEqualTo(204);
        verify(recordResendUseCase).recordResendOutcome("r1", "orig", "new1");
    }
}
