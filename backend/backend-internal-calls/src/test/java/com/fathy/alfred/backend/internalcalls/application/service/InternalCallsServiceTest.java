package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.lang.reflect.Field;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class InternalCallsServiceTest {

    private static final int TEST_MAX_LIMIT = 500;

    private static CallSummary summary(String url) {
        return new CallSummary("id-" + url, url, url, "GET", "t", 1.0, null, null, null);
    }

    private static CallsQuery query(int offset, int limit) {
        return new CallsQuery("", "", "newest", offset, limit, "", "", "");
    }

    private static InternalCallsService serviceWith(CallLogPort port) {
        return serviceWith(port, mock(CallNotificationPort.class), List.of());
    }

    private static InternalCallsService serviceWith(CallLogPort port, CallNotificationPort notificationPort) {
        return serviceWith(port, notificationPort, List.of());
    }

    private static InternalCallsService serviceWith(CallLogPort port, CallNotificationPort notificationPort, List<NewInternalCallObserverPort> observers) {
        InternalCallsService service = new InternalCallsService(port, notificationPort, observers);
        setMaxLimit(service, TEST_MAX_LIMIT);
        setPaginationEnabled(service, true);
        return service;
    }

    /** maxLimit/paginationEnabled are @Value-injected by Spring in production; unit tests construct InternalCallsService directly. */
    private static void setMaxLimit(InternalCallsService service, int maxLimit) {
        try {
            Field field = InternalCallsService.class.getDeclaredField("maxLimit");
            field.setAccessible(true);
            field.setInt(service, maxLimit);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static void setPaginationEnabled(InternalCallsService service, boolean paginationEnabled) {
        try {
            Field field = InternalCallsService.class.getDeclaredField("paginationEnabled");
            field.setAccessible(true);
            field.setBoolean(service, paginationEnabled);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void passesThePortsPageOfCallSummariesThroughUnchanged() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query("", "", "newest", 0, 50, true, "", "", ""))
                .thenReturn(new CallListSupport.Page<>(List.of(summary("c"), summary("b")), 3));
        InternalCallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(0, 50));

        assertThat(result.calls()).extracting(CallSummary::url).containsExactly("c", "b");
        assertThat(result.total()).isEqualTo(3);
    }

    @Test
    void clampsANegativeOffsetUpToZero() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean(), anyString(), anyString(), anyString()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        InternalCallsService service = serviceWith(port);

        service.getCalls(query(-5, 2));

        verify(port).query("", "", "newest", 0, 2, true, "", "", "");
    }

    @Test
    void clampsALimitAboveTheMaximum() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean(), anyString(), anyString(), anyString()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        InternalCallsService service = serviceWith(port);

        service.getCalls(query(0, TEST_MAX_LIMIT + 50));

        verify(port).query("", "", "newest", 0, TEST_MAX_LIMIT, true, "", "", "");
    }

    @Test
    void disabledPaginationIgnoresTheRequestedLimitAndUsesMaxLimitInstead() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean(), anyString(), anyString(), anyString()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        InternalCallsService service = serviceWith(port);
        setPaginationEnabled(service, false);

        service.getCalls(query(2, 50));

        verify(port).query("", "", "newest", 2, TEST_MAX_LIMIT, false, "", "", "");
    }

    @Test
    void getDetailDelegatesToFindById() {
        CallLogPort port = mock(CallLogPort.class);
        CallRecord found = new CallRecord("id-1", "https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);
        when(port.findById("id-1")).thenReturn(Optional.of(found));
        InternalCallsService service = serviceWith(port);

        assertThat(service.getDetail("id-1")).isPresent();
        assertThat(service.getDetail("missing")).isEmpty();
    }

    @Test
    void receivePreparedCallAssignsAnIdSavesItInProgressAndNotifies() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord partial = new CallRecord(null, "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t", null, null, null, null);
        InternalCallsService service = serviceWith(port, notificationPort);

        Optional<String> id = service.receivePreparedCall(partial);

        assertThat(id).isPresent();
        ArgumentCaptor<CallRecord> prepared = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).prepare(prepared.capture());
        assertThat(prepared.getValue().id()).isEqualTo(id.get());
        assertThat(prepared.getValue().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        assertThat(prepared.getValue().response()).isNull();
        // No fallback for these two - a call the proxy didn't tag with either simply has null,
        // never a server-invented value (matches backend-calls' CallsService rule).
        assertThat(prepared.getValue().sessionId()).isNull();
        assertThat(prepared.getValue().operationId()).isNull();
        var order = inOrder(port, notificationPort);
        order.verify(port).prepare(prepared.getValue());
        order.verify(notificationPort).notifyCallPrepared(prepared.getValue());
    }

    @Test
    void receivePreparedCallUsesTheProxySuppliedIdInsteadOfGeneratingOne() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord partial = new CallRecord("proxy-generated-id", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t", null, null, null, null);
        InternalCallsService service = serviceWith(port, notificationPort);

        Optional<String> id = service.receivePreparedCall(partial);

        assertThat(id).contains("proxy-generated-id");
        ArgumentCaptor<CallRecord> prepared = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).prepare(prepared.capture());
        assertThat(prepared.getValue().id()).isEqualTo("proxy-generated-id");
    }

    @Test
    void receivePreparedCallUsesTheProxySuppliedSessionAndOperationIds() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord partial = new CallRecord("id-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t",
                null, null, null, null, "proxy-session-id", "proxy-operation-id");
        InternalCallsService service = serviceWith(port, notificationPort);

        service.receivePreparedCall(partial);

        ArgumentCaptor<CallRecord> prepared = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).prepare(prepared.capture());
        assertThat(prepared.getValue().sessionId()).isEqualTo("proxy-session-id");
        assertThat(prepared.getValue().operationId()).isEqualTo("proxy-operation-id");
    }

    @Test
    void receiveCompletedCallUpdatesFindsThenNotifiesInOrder() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord completed = new CallRecord("call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t", 1.0, null, null);
        ResponseData response = new ResponseData(200, null, "{}");
        when(port.complete("call-1", response, null, 42.0)).thenReturn(true);
        when(port.findById("call-1")).thenReturn(Optional.of(completed));
        InternalCallsService service = serviceWith(port, notificationPort);

        boolean result = service.receiveCompletedCall("call-1", response, null, 42.0);

        assertThat(result).isTrue();
        var order = inOrder(port, notificationPort);
        order.verify(port).complete("call-1", response, null, 42.0);
        order.verify(port).findById("call-1");
        order.verify(notificationPort).notifyCallCompleted(completed, List.of());
    }

    @Test
    void receiveCompletedCallFansOutToObserversThenNotifiesWithTheirCycleIds() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewInternalCallObserverPort observerA = mock(NewInternalCallObserverPort.class);
        NewInternalCallObserverPort observerB = mock(NewInternalCallObserverPort.class);
        CallRecord completed = new CallRecord("call-1", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t", 1.0, null, null);
        ResponseData response = new ResponseData(200, null, "{}");
        when(port.complete("call-1", response, null, 42.0)).thenReturn(true);
        when(port.findById("call-1")).thenReturn(Optional.of(completed));
        when(observerA.onCallCompleted(completed)).thenReturn(List.of("cycle-1"));
        when(observerB.onCallCompleted(completed)).thenReturn(List.of("cycle-2"));
        InternalCallsService service = serviceWith(port, notificationPort, List.of(observerA, observerB));

        boolean result = service.receiveCompletedCall("call-1", response, null, 42.0);

        assertThat(result).isTrue();
        var order = inOrder(port, observerA, observerB, notificationPort);
        order.verify(port).complete("call-1", response, null, 42.0);
        order.verify(observerA).onCallCompleted(completed);
        order.verify(observerB).onCallCompleted(completed);
        order.verify(notificationPort).notifyCallCompleted(completed, List.of("cycle-1", "cycle-2"));
    }

    @Test
    void receiveCompletedCallReturnsFalseAndSkipsFanOutAndNotifyWhenThePortReportsTheCallWasNeverPrepared() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewInternalCallObserverPort observer = mock(NewInternalCallObserverPort.class);
        when(port.complete("missing", null, "timeout", null)).thenReturn(false);
        InternalCallsService service = serviceWith(port, notificationPort, List.of(observer));

        boolean result = service.receiveCompletedCall("missing", null, "timeout", null);

        assertThat(result).isFalse();
        verify(port, never()).findById(org.mockito.ArgumentMatchers.any());
        verifyNoInteractions(observer, notificationPort);
    }
}
