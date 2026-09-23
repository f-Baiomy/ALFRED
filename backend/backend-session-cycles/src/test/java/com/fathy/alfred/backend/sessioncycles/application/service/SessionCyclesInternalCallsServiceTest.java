package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSpacer;
import com.fathy.alfred.backend.sessioncycles.domain.model.RemoveCallsResult;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
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

class SessionCyclesInternalCallsServiceTest {

    private final SessionCycleMetadataStorePort metadataStore = mock(SessionCycleMetadataStorePort.class);
    private final CapturedInternalCallsStorePort capturedInternalCallsStore = mock(CapturedInternalCallsStorePort.class);
    private final CycleSpacersStorePort spacersStore = mock(CycleSpacersStorePort.class);
    private final SessionCyclesInternalCallsService service = newService(metadataStore, capturedInternalCallsStore, spacersStore);

    private static final CallsQuery DEFAULT_QUERY = new CallsQuery("", "", "oldest", 0, 10, "", "", "");

    private static SessionCyclesInternalCallsService newService(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore, CycleSpacersStorePort spacersStore) {
        SessionCyclesInternalCallsService service = new SessionCyclesInternalCallsService(metadataStore, capturedInternalCallsStore, spacersStore);
        try {
            Field maxLimitField = SessionCyclesInternalCallsService.class.getDeclaredField("maxLimit");
            maxLimitField.setAccessible(true);
            maxLimitField.setInt(service, 200);

            Field paginationEnabledField = SessionCyclesInternalCallsService.class.getDeclaredField("paginationEnabled");
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

    private static CallRecord call(String timestamp) {
        return new CallRecord("id-" + timestamp, "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, timestamp, 1.0, null, null);
    }

    private static CapturedInternalCall captured(CallRecord call) {
        return new CapturedInternalCall("captured-" + call.timestamp(), "2026-01-01T00:00:00Z", call);
    }

    @Test
    void listCallsReturnsEmptyOptionalWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.listCalls("missing", DEFAULT_QUERY)).isEmpty();
        verify(capturedInternalCallsStore, never()).query(any(), any(), any(), any(), org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyInt(), org.mockito.ArgumentMatchers.anyBoolean(), any(), any(), any());
    }

    @Test
    void listCallsReturnsThePossiblyEmptyCapturedList() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.query("c1", "", "", "oldest", 0, 10, true, "", "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(CapturedInternalCallSummary.of(captured(call("t1")))), 1));

        var result = service.listCalls("c1", DEFAULT_QUERY);

        assertThat(result).isPresent();
        assertThat(result.get().calls()).hasSize(1);
        assertThat(result.get().total()).isEqualTo(1);
    }

    @Test
    void disabledPaginationIgnoresTheRequestedLimitAndUsesMaxLimitInstead() throws ReflectiveOperationException {
        Field paginationEnabledField = SessionCyclesInternalCallsService.class.getDeclaredField("paginationEnabled");
        paginationEnabledField.setAccessible(true);
        paginationEnabledField.setBoolean(service, false);

        CapturedInternalCall first = captured(call("t1"));
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.query("c1", "", "", "oldest", 1, 200, false, "", "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(CapturedInternalCallSummary.of(first)), 1));

        var result = service.listCalls("c1", new CallsQuery("", "", "oldest", 1, 10, "", "", ""));

        assertThat(result).isPresent();
        assertThat(result.get().calls()).containsExactly(CapturedInternalCallSummary.of(first));
    }

    @Test
    void getDetailReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.getDetail("missing", "id-t1")).isEmpty();
    }

    @Test
    void getDetailReturnsEmptyWhenTheCallIdDoesNotMatchAnyCapturedCall() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findByCallId("c1", "missing-id")).thenReturn(Optional.empty());

        assertThat(service.getDetail("c1", "missing-id")).isEmpty();
    }

    @Test
    void getDetailLooksUpByTheUnderlyingCallRecordIdNotTheCapturedCallWrapperId() {
        CallRecord underlying = call("t1");
        CapturedInternalCall captured = captured(underlying);
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findByCallId("c1", underlying.id())).thenReturn(Optional.of(captured));
        when(capturedInternalCallsStore.findByCallId("c1", captured.id())).thenReturn(Optional.empty());

        Optional<CallDetail> result = service.getDetail("c1", underlying.id());

        assertThat(result).contains(CallDetail.of(underlying));
        assertThat(service.getDetail("c1", captured.id())).isEmpty();
    }

    @Test
    void removeCallDelegatesToTheStore() {
        when(capturedInternalCallsStore.removeById("c1", "call-1")).thenReturn(true);

        assertThat(service.removeCall("c1", "call-1")).isTrue();
        verify(capturedInternalCallsStore).removeById(eq("c1"), eq("call-1"));
    }

    @Test
    void removeCallsReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.removeCalls("missing", List.of("call-1"))).isEmpty();
        verify(capturedInternalCallsStore, never()).removeByIds(any(), any());
    }

    @Test
    void removeCallsReturnsTheRemovedAndNotFoundCounts() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.removeByIds("c1", List.of("call-1", "call-2", "missing"))).thenReturn(2);

        Optional<RemoveCallsResult> result = service.removeCalls("c1", List.of("call-1", "call-2", "missing"));

        assertThat(result).contains(new RemoveCallsResult(2, 1));
    }

    @Test
    void copyIntoReturnsEmptyWhenTheCycleDoesNotExist() {
        when(metadataStore.findById("missing")).thenReturn(Optional.empty());

        assertThat(service.copyInto("missing", List.of(call("t1")))).isEmpty();
        verify(capturedInternalCallsStore, never()).append(any(), any());
    }

    @Test
    void copyIntoAppendsEveryCallNotAlreadyPresentByUnderlyingId() {
        CallRecord existing = call("t1");
        CallRecord fresh = call("t2");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of(captured(existing)));

        CopyCallsResult result = service.copyInto("c1", List.of(existing, fresh)).orElseThrow();

        assertThat(result).isEqualTo(new CopyCallsResult(1, 1));
        verify(capturedInternalCallsStore).append("c1", fresh);
        verify(capturedInternalCallsStore, never()).append("c1", existing);
    }

    @Test
    void copyIntoReAnchorsAnyTrailingSpacerToTheFirstNewlyAddedCall() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());
        CycleSpacer trailing = new CycleSpacer("s1", "c1", "End of repro", null, "2026-01-01T00:00:00Z", null);
        // The real store would stop returning this as trailing once move() re-anchors it - see
        // SessionCyclesServiceTest's identical fixture for why this simulates that with a mock.
        when(spacersStore.findAllByCycle("c1")).thenReturn(List.of(trailing), List.of());

        CallRecord a = call("t1");
        CallRecord b = call("t2");
        service.copyInto("c1", List.of(a, b));

        verify(spacersStore, org.mockito.Mockito.times(1)).move(eq("c1"), eq("s1"), any(), any());
        verify(spacersStore).move("c1", "s1", a.id(), a.timestamp());
    }

    @Test
    void copyIntoSkipsDuplicatesWithinTheSameBatchToo() {
        CallRecord call = call("t1");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CopyCallsResult result = service.copyInto("c1", List.of(call, call)).orElseThrow();

        assertThat(result).isEqualTo(new CopyCallsResult(1, 1));
        verify(capturedInternalCallsStore, org.mockito.Mockito.times(1)).append("c1", call);
    }

    @Test
    void copyIntoDoesNotAnchorATrailingSpacerToAnOptionsPreflightSinceThatWouldMakeItVanishFromEveryView() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());
        CycleSpacer trailing = new CycleSpacer("s1", "c1", "End of repro", null, "2026-01-01T00:00:00Z", null);
        when(spacersStore.findAllByCycle("c1")).thenReturn(List.of(trailing));
        CallRecord optionsCall = new CallRecord("id-t1", "https://wildfly-proxy/x", "https://wildfly/x", "OPTIONS", null, "t1", 1.0, null, null);

        service.copyInto("c1", List.of(optionsCall));

        verify(spacersStore, never()).move(any(), any(), any(), any());
    }

    @Test
    void copyIntoDoesNotRePinASpacerWhoseAnchorCallWasDeletedSinceItIsStillPlacedByItsTimestamp() {
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());
        CycleSpacer orphaned = new CycleSpacer("s1", "c1", "Anchor was deleted", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:03Z");
        when(spacersStore.findAllByCycle("c1")).thenReturn(List.of(orphaned));

        service.copyInto("c1", List.of(new CallRecord("id-t1", "https://a.com-proxy/x", "https://a.com/x", "GET", null, "t1", 1.0, null, null)));

        verify(spacersStore, never()).move(any(), any(), any(), any());
    }

    @Test
    void removeCallRepointsAnySpacerAnchoredToTheRemovedCallsUnderlyingId() {
        CallRecord call = call("t1");
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of(captured(call)));
        when(capturedInternalCallsStore.removeById("c1", "captured-t1")).thenReturn(true);

        service.removeCall("c1", "captured-t1");

        verify(spacersStore).dropAnchorsTo("c1", List.of("id-t1"));
    }

    @Test
    void removeCallLeavesSpacersAloneWhenNothingWasRemoved() {
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());
        when(capturedInternalCallsStore.removeById("c1", "missing")).thenReturn(false);

        service.removeCall("c1", "missing");

        verify(spacersStore, never()).dropAnchorsTo(any(), any());
    }

    @Test
    void removeCallsRepointsSpacersAnchoredToEveryRemovedCallsUnderlyingId() {
        CallRecord a = call("t1");
        CallRecord b = call("t2");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of(captured(a), captured(b)));
        when(capturedInternalCallsStore.removeByIds("c1", List.of("captured-t1", "captured-t2"))).thenReturn(2);

        service.removeCalls("c1", List.of("captured-t1", "captured-t2"));

        verify(spacersStore).dropAnchorsTo("c1", List.of("id-t1", "id-t2"));
    }
}
