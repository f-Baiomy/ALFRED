package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.internalcalls.application.service.CallListSupport;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CopyCallsResult;
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
    private final SessionCyclesInternalCallsService service = newService(metadataStore, capturedInternalCallsStore);

    private static final CallsQuery DEFAULT_QUERY = new CallsQuery("", "", "oldest", 0, 10, "", "", "");

    private static SessionCyclesInternalCallsService newService(SessionCycleMetadataStorePort metadataStore, CapturedInternalCallsStorePort capturedInternalCallsStore) {
        SessionCyclesInternalCallsService service = new SessionCyclesInternalCallsService(metadataStore, capturedInternalCallsStore);
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
        when(capturedInternalCallsStore.query("c1", "", "", "oldest", 0, 10, true, "", "", ""))
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
        when(capturedInternalCallsStore.query("c1", "", "", "oldest", 1, 200, false, "", "", ""))
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
    void copyIntoSkipsDuplicatesWithinTheSameBatchToo() {
        CallRecord call = call("t1");
        when(metadataStore.findById("c1")).thenReturn(Optional.of(cycle("c1", SessionCycleStatus.PAUSED)));
        when(capturedInternalCallsStore.findAllByCycle("c1")).thenReturn(List.of());

        CopyCallsResult result = service.copyInto("c1", List.of(call, call)).orElseThrow();

        assertThat(result).isEqualTo(new CopyCallsResult(1, 1));
        verify(capturedInternalCallsStore, org.mockito.Mockito.times(1)).append("c1", call);
    }
}
