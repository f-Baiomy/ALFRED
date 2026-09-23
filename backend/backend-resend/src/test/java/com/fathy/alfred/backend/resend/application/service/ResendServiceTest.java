package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.out.ResendLogPort;
import com.fathy.alfred.backend.resend.domain.model.ResendOutcome;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class ResendServiceTest {

    @Test
    void recordResendOutcomeSavesAnOutcomeLinkingTheNewCallBackToTheOriginal() {
        ResendLogPort resendLogPort = mock(ResendLogPort.class);
        ResendService service = new ResendService(resendLogPort);

        service.recordResendOutcome("request-1", "original-call", "new-call");

        var captor = org.mockito.ArgumentCaptor.forClass(ResendOutcome.class);
        verify(resendLogPort).saveOutcome(captor.capture());
        ResendOutcome saved = captor.getValue();
        assertThat(saved.resendRequestId()).isEqualTo("request-1");
        assertThat(saved.originalCallId()).isEqualTo("original-call");
        assertThat(saved.newCallId()).isEqualTo("new-call");
        assertThat(saved.id()).isNotBlank();
        assertThat(saved.timestamp()).isNotBlank();
    }
}
