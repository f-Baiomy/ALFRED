package com.alfred.pennyworth.sessioncycles.application.service;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.alfred.pennyworth.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.alfred.pennyworth.sessioncycles.domain.model.CapturedCall;
import com.alfred.pennyworth.sessioncycles.domain.model.CopyCallsResult;
import com.alfred.pennyworth.sessioncycles.domain.model.DeleteOutcome;
import com.alfred.pennyworth.sessioncycles.domain.model.NewSessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycle;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycleStatus;
import com.alfred.pennyworth.sessioncycles.domain.model.SessionCycleUpdate;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SessionCyclesServiceTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedCallsStorePort capturedCallsStore = mock(CapturedCallsStorePort.class);
    private final SessionCyclesService service = new SessionCyclesService(metadataStore, capturedCallsStore);

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "2026-01-01T00:00:00Z", null, status);
    }

    @Test
    void createStartsPausedAndSaves() {
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        SessionCycle created = service.create(new NewSessionCycle("Repro flight bug", "profile-1"));

        assertThat(created.id()).isNotBlank();
        assertThat(created.name()).isEqualTo("Repro flight bug");
        assertThat(created.assignedTo()).isEqualTo("profile-1");
        assertThat(created.status()).isEqualTo(SessionCycleStatus.PAUSED);
        verify(metadataStore).save(created);
    }

    @Test
    void updateAppliesOnlyNonNullFields() {
        SessionCycle existing = new SessionCycle("c1", "Old name", "t", "old-assignee", SessionCycleStatus.PAUSED);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(existing));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.update("c1", new SessionCycleUpdate("New name", null));

        assertThat(result).isPresent();
        assertThat(result.get().name()).isEqualTo("New name");
        assertThat(result.get().assignedTo()).isEqualTo("old-assignee");
    }

    @Test
    void updateReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.update("missing", new SessionCycleUpdate("x", null))).isEmpty();
    }

    @Test
    void startRecordingSetsStatusToRecording() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.startRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
    }

    @Test
    void startRecordingIsIdempotentAndDoesNotResave() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));

        Optional<SessionCycle> result = service.startRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
        verify(metadataStore, never()).save(any());
    }

    @Test
    void pauseRecordingSetsStatusToPaused() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.pauseRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.PAUSED);
    }

    @Test
    void startRecordingReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.startRecording("missing")).isEmpty();
    }

    @Test
    void deleteReturnsNotFoundWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.delete("missing")).isEqualTo(DeleteOutcome.NOT_FOUND);
        verify(metadataStore, never()).deleteById(any());
    }

    @Test
    void deleteIsBlockedWhileRecording() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));

        assertThat(service.delete("c1")).isEqualTo(DeleteOutcome.BLOCKED_RECORDING);
        verify(metadataStore, never()).deleteById(any());
        verify(capturedCallsStore, never()).deleteAllForCycle(any());
    }

    @Test
    void deleteHardDeletesMetadataAndCapturedCallsWhenPaused() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));

        assertThat(service.delete("c1")).isEqualTo(DeleteOutcome.DELETED);
        verify(metadataStore).deleteById("c1");
        verify(capturedCallsStore).deleteAllForCycle("c1");
    }

    @Test
    void listCallsReturnsEmptyOptionalWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.listCalls("missing")).isEmpty();
        verify(capturedCallsStore, never()).findAllByCycle(any());
    }

    @Test
    void listCallsReturnsThePossiblyEmptyCapturedList() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of(mock(CapturedCall.class)));

        Optional<List<CapturedCall>> result = service.listCalls("c1");

        assertThat(result).isPresent();
        assertThat(result.get()).hasSize(1);
    }

    @Test
    void listCallsReversesStoreOrderToNewestFirst() {
        CapturedCall first = mock(CapturedCall.class);
        CapturedCall second = mock(CapturedCall.class);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of(first, second));

        Optional<List<CapturedCall>> result = service.listCalls("c1");

        assertThat(result).isPresent();
        assertThat(result.get()).containsExactly(second, first);
    }

    @Test
    void removeCallDelegatesToTheStore() {
        when(capturedCallsStore.removeById("c1", "call-1")).thenReturn(true);

        assertThat(service.removeCall("c1", "call-1")).isTrue();
        verify(capturedCallsStore).removeById(eq("c1"), eq("call-1"));
    }

    private static CallRecord call(String timestamp) {
        return new CallRecord("https://a.com-proxy/x", "https://a.com/x", "GET", null, timestamp, 1.0, null, null);
    }

    private static CapturedCall captured(CallRecord call) {
        return new CapturedCall("captured-" + call.timestamp(), "2026-01-01T00:00:00Z", call);
    }

    @Test
    void copyIntoReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.copyInto("missing", List.of(call("t1")))).isEmpty();
        verify(capturedCallsStore, never()).append(any(), any());
    }

    @Test
    void copyIntoAppendsNewCallsAndCountsThem() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CallRecord a = call("t1");
        CallRecord b = call("t2");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(a, b));

        assertThat(result).contains(new CopyCallsResult(2, 0));
        verify(capturedCallsStore).append("c1", a);
        verify(capturedCallsStore).append("c1", b);
    }

    @Test
    void copyIntoSkipsCallsAlreadyPresentByContent() {
        CallRecord existingContent = call("t1");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of(captured(existingContent)));

        CallRecord duplicate = call("t1");
        CallRecord fresh = call("t2");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(duplicate, fresh));

        assertThat(result).contains(new CopyCallsResult(1, 1));
        verify(capturedCallsStore, never()).append("c1", duplicate);
        verify(capturedCallsStore).append("c1", fresh);
    }

    @Test
    void copyIntoSkipsDuplicatesWithinTheSameBatchToo() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CallRecord a = call("t1");
        CallRecord sameContent = call("t1");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(a, sameContent));

        assertThat(result).contains(new CopyCallsResult(1, 1));
        verify(capturedCallsStore, org.mockito.Mockito.times(1)).append(eq("c1"), any());
    }

    @Test
    void copyIntoWorksRegardlessOfRecordingStatus() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(call("t1")));

        assertThat(result).contains(new CopyCallsResult(1, 0));
    }
}
