package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/** A deleted call never leaves pieces behind: inbound takes its captures and triage mark, outbound its triage mark. */
class CallDeletionCascadeTest {

    private final DeleteCallStatementsUseCase captures = mock(DeleteCallStatementsUseCase.class);
    private final RecordCallAttentionUseCase triage = mock(RecordCallAttentionUseCase.class);
    private final CallDeletionCascade cascade = new CallDeletionCascade(captures, triage, Runnable::run);

    @Test
    void aDeletedInboundCallTakesItsCapturesAndItsTriageMark() {
        new CallDeletionCascade.InboundCallsRemoved(cascade).callsRemoved(List.of("in-1", "in-2"));

        verify(captures).callsDeleted(List.of("in-1", "in-2"));
        verify(triage).callsDeleted(List.of("in-1", "in-2"));
    }

    @Test
    void aDeletedOutboundCallTakesOnlyItsTriageMark() {
        new CallDeletionCascade.OutboundCallsRemoved(cascade).callsRemoved(List.of("out-1"));

        verify(triage).callsDeleted(List.of("out-1"));
        verify(captures, never()).callsDeleted(anyCollection());
    }

    @Test
    void aFailedCaptureDeleteStillRemovesTheTriageMark() {
        doThrow(new IllegalStateException("db-capture.db is locked")).when(captures).callsDeleted(anyCollection());

        new CallDeletionCascade.InboundCallsRemoved(cascade).callsRemoved(List.of("in-1"));

        verify(triage).callsDeleted(List.of("in-1"));
    }

    @Test
    void nothingDeletedAsksNothing() {
        new CallDeletionCascade.InboundCallsRemoved(cascade).callsRemoved(List.of());

        verify(captures, never()).callsDeleted(anyCollection());
        verify(triage, never()).callsDeleted(anyCollection());
    }
}
