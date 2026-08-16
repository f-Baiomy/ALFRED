package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.DeleteOutcome;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleUpdate;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
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
    private final SessionCycleNotificationPort notificationPort = mock(SessionCycleNotificationPort.class);
    private final SessionCyclesService service = newService(metadataStore, capturedCallsStore, notificationPort);

    private static final CallsQuery DEFAULT_QUERY = new CallsQuery("", "", "oldest", 0, 10);

    /** maxLimit/paginationEnabled are @Value-injected by Spring in production; unit tests construct SessionCyclesService directly, so they're set the same way CallsServiceTest sets its own @Value fields. */
    private static SessionCyclesService newService(SessionCycleMetadataStorePort metadataStore, CapturedCallsStorePort capturedCallsStore, SessionCycleNotificationPort notificationPort) {
        SessionCyclesService service = new SessionCyclesService(metadataStore, capturedCallsStore, notificationPort);
        try {
            Field maxLimitField = SessionCyclesService.class.getDeclaredField("maxLimit");
            maxLimitField.setAccessible(true);
            maxLimitField.setInt(service, 200);

            Field paginationEnabledField = SessionCyclesService.class.getDeclaredField("paginationEnabled");
            paginationEnabledField.setAccessible(true);
            paginationEnabledField.setBoolean(service, true);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return service;
    }

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
        verify(notificationPort).notifySessionCyclesChanged();
    }

    @Test
    void updateWithANullNameLeavesTheExistingNameAlone() {
        SessionCycle existing = new SessionCycle("c1", "Old name", "t", "old-assignee", SessionCycleStatus.PAUSED);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(existing));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.update("c1", new SessionCycleUpdate(null, "new-assignee"));

        assertThat(result).isPresent();
        assertThat(result.get().name()).isEqualTo("Old name");
        assertThat(result.get().assignedTo()).isEqualTo("new-assignee");
        verify(notificationPort).notifySessionCyclesChanged();
    }

    @Test
    void updateWithANullAssignedToClearsItBackToUnassigned() {
        SessionCycle existing = new SessionCycle("c1", "Old name", "t", "old-assignee", SessionCycleStatus.PAUSED);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(existing));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.update("c1", new SessionCycleUpdate("New name", null));

        assertThat(result).isPresent();
        assertThat(result.get().name()).isEqualTo("New name");
        assertThat(result.get().assignedTo()).isNull();
    }

    @Test
    void updateReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.update("missing", new SessionCycleUpdate("x", null))).isEmpty();
        verify(notificationPort, never()).notifySessionCyclesChanged();
    }

    @Test
    void startRecordingSetsStatusToRecording() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.startRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
        verify(notificationPort).notifySessionCyclesChanged();
    }

    @Test
    void startRecordingIsIdempotentAndDoesNotResave() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));

        Optional<SessionCycle> result = service.startRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
        verify(metadataStore, never()).save(any());
        verify(notificationPort, never()).notifySessionCyclesChanged();
    }

    @Test
    void pauseRecordingSetsStatusToPaused() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.RECORDING)));
        when(metadataStore.save(any())).thenAnswer(inv -> inv.getArgument(0));

        Optional<SessionCycle> result = service.pauseRecording("c1");

        assertThat(result).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.PAUSED);
        verify(notificationPort).notifySessionCyclesChanged();
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
        verify(notificationPort).notifySessionCyclesChanged();
    }

    @Test
    void listCallsReturnsEmptyOptionalWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.listCalls("missing", DEFAULT_QUERY)).isEmpty();
        verify(capturedCallsStore, never()).findAllByCycle(any());
    }

    // Filtering/sorting/pagination itself now lives in whichever CapturedCallsStorePort adapter is
    // active (CallListSupport for the file adapter, SQL for the SQLite adapter - see their own
    // tests), so these stub query(...) directly rather than findAllByCycle - mirrors the same
    // change made to CallsServiceTest.

    @Test
    void listCallsReturnsThePossiblyEmptyCapturedList() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.query("c1", "", "", "oldest", 0, 10, true, "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(CapturedCallSummary.of(captured(call("t1")))), 1));

        var result = service.listCalls("c1", DEFAULT_QUERY);

        assertThat(result).isPresent();
        assertThat(result.get().calls()).hasSize(1);
        assertThat(result.get().total()).isEqualTo(1);
    }

    @Test
    void listCallsPassesTheSortModeThrough() {
        CapturedCall first = captured(call("t1"));
        CapturedCall second = captured(call("t2"));
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.query("c1", "", "", "newest", 0, 10, true, "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(CapturedCallSummary.of(second), CapturedCallSummary.of(first)), 2));

        var result = service.listCalls("c1", new CallsQuery("", "", "newest", 0, 10));

        assertThat(result).isPresent();
        assertThat(result.get().calls()).containsExactly(CapturedCallSummary.of(second), CapturedCallSummary.of(first));
    }

    @Test
    void disabledPaginationIgnoresTheRequestedLimitAndUsesMaxLimitInstead() throws ReflectiveOperationException {
        Field paginationEnabledField = SessionCyclesService.class.getDeclaredField("paginationEnabled");
        paginationEnabledField.setAccessible(true);
        paginationEnabledField.setBoolean(service, false);

        CapturedCall first = captured(call("t1"));
        CapturedCall second = captured(call("t2"));
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.query("c1", "", "", "oldest", 1, 200, false, "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(CapturedCallSummary.of(first), CapturedCallSummary.of(second)), 2));

        var result = service.listCalls("c1", new CallsQuery("", "", "oldest", 1, 10));

        assertThat(result).isPresent();
        assertThat(result.get().calls()).containsExactly(CapturedCallSummary.of(first), CapturedCallSummary.of(second));
        assertThat(result.get().total()).isEqualTo(2);
    }

    @Test
    void getDetailReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.getDetail("missing", "id-t1")).isEmpty();
    }

    @Test
    void getDetailReturnsEmptyWhenTheCallIdDoesNotMatchAnyCapturedCall() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findByCallId("c1", "missing-id")).thenReturn(Optional.empty());

        assertThat(service.getDetail("c1", "missing-id")).isEmpty();
    }

    @Test
    void getDetailLooksUpByTheUnderlyingCallRecordIdNotTheCapturedCallWrapperId() {
        CallRecord underlying = call("t1");
        CapturedCall captured = captured(underlying);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findByCallId("c1", underlying.id())).thenReturn(Optional.of(captured));
        when(capturedCallsStore.findByCallId("c1", captured.id())).thenReturn(Optional.empty());

        Optional<CallDetail> result = service.getDetail("c1", underlying.id());

        assertThat(result).contains(CallDetail.of(underlying));
        // The wrapper's own id (captured.id()) is a different, unrelated identifier - looking it
        // up as if it were the call id must not match.
        assertThat(service.getDetail("c1", captured.id())).isEmpty();
    }

    @Test
    void removeCallDelegatesToTheStore() {
        when(capturedCallsStore.removeById("c1", "call-1")).thenReturn(true);

        assertThat(service.removeCall("c1", "call-1")).isTrue();
        verify(capturedCallsStore).removeById(eq("c1"), eq("call-1"));
    }

    @Test
    void removeCallsReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.removeCalls("missing", List.of("call-1"))).isEmpty();
        verify(capturedCallsStore, never()).removeByIds(any(), any());
    }

    @Test
    void removeCallsReturnsTheRemovedAndNotFoundCounts() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.removeByIds("c1", List.of("call-1", "call-2", "missing"))).thenReturn(2);

        Optional<RemoveCallsResult> result = service.removeCalls("c1", List.of("call-1", "call-2", "missing"));

        assertThat(result).contains(new RemoveCallsResult(2, 1));
    }

    private static CallRecord call(String timestamp) {
        return new CallRecord("id-" + timestamp, "https://a.com-proxy/x", "https://a.com/x", "GET", null, timestamp, 1.0, null, null);
    }

    private static CallRecord callWithId(String id, String timestamp) {
        return new CallRecord(id, "https://a.com-proxy/x", "https://a.com/x", "GET", null, timestamp, 1.0, null, null);
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
    void copyIntoSkipsCallsAlreadyPresentByCallId() {
        CallRecord existing = callWithId("shared-id", "t1");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of(captured(existing)));

        // Same id as the already-captured call, but a different timestamp - still the same call
        // (e.g. re-selected after its timestamp was reformatted upstream), and must still be
        // recognized as a duplicate. This is the actual bug this dedup-by-id switch fixes: content
        // (timestamp+method+originalUrl) matching missed this, id matching doesn't.
        CallRecord duplicate = callWithId("shared-id", "t1-reformatted");
        CallRecord fresh = call("t2");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(duplicate, fresh));

        assertThat(result).contains(new CopyCallsResult(1, 1));
        verify(capturedCallsStore, never()).append("c1", duplicate);
        verify(capturedCallsStore).append("c1", fresh);
    }

    @Test
    void copyIntoDoesNotSkipDifferentCallsThatShareTheSameContent() {
        // Two distinct calls (different ids) that happen to share timestamp+method+originalUrl -
        // e.g. two separate requests to the same URL in the same millisecond. Content-based
        // matching used to wrongly treat these as duplicates; id-based matching must not.
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CallRecord a = callWithId("id-a", "t1");
        CallRecord b = callWithId("id-b", "t1");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(a, b));

        assertThat(result).contains(new CopyCallsResult(2, 0));
        verify(capturedCallsStore).append("c1", a);
        verify(capturedCallsStore).append("c1", b);
    }

    @Test
    void copyIntoSkipsDuplicatesWithinTheSameBatchToo() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CallRecord a = call("t1");
        CallRecord sameId = call("t1");
        Optional<CopyCallsResult> result = service.copyInto("c1", List.of(a, sameId));

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
