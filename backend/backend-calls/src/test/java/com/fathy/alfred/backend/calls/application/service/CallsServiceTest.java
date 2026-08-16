package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.application.port.out.CallFilterPort;
import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
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

class CallsServiceTest {

    private static final int TEST_MAX_LIMIT = 500;

    private static CallRecord call(String url) {
        return new CallRecord("id-" + url, url, url, "GET", null, "t", 1.0, null, null);
    }

    private static CallSummary summary(String url) {
        return new CallSummary("id-" + url, url, url, "GET", "t", 1.0, null, null, null);
    }

    private static CallsQuery query(int offset, int limit) {
        return new CallsQuery("", "", "newest", offset, limit);
    }

    private static CallsService serviceWith(CallLogPort port) {
        return serviceWith(port, mock(CallNotificationPort.class), List.of());
    }

    private static CallsService serviceWith(CallLogPort port, CallNotificationPort notificationPort, List<NewCallObserverPort> observers) {
        return serviceWith(port, notificationPort, observers, Optional.empty());
    }

    private static CallsService serviceWith(CallLogPort port, CallNotificationPort notificationPort,
                                              List<NewCallObserverPort> observers, Optional<CallFilterPort> callFilterPort) {
        CallsService service = new CallsService(port, notificationPort, observers, callFilterPort);
        setMaxLimit(service, TEST_MAX_LIMIT);
        setPaginationEnabled(service, true);
        return service;
    }

    /** maxLimit/paginationEnabled are @Value-injected by Spring in production; unit tests construct CallsService directly, so they're set the same way FileCallLogAdapterTest sets its own @Value fields. */
    private static void setMaxLimit(CallsService service, int maxLimit) {
        try {
            Field field = CallsService.class.getDeclaredField("maxLimit");
            field.setAccessible(true);
            field.setInt(service, maxLimit);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    private static void setPaginationEnabled(CallsService service, boolean paginationEnabled) {
        try {
            Field field = CallsService.class.getDeclaredField("paginationEnabled");
            field.setAccessible(true);
            field.setBoolean(service, paginationEnabled);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    // Filtering/sorting/pagination itself now lives in whichever CallLogPort adapter is active
    // (CallListSupport for the file adapter, SQL for the SQLite adapter - see their own tests);
    // CallsService's job here is just clamping offset/limit and passing the port's
    // Page<CallSummary> straight through to CallsPage, so these tests stub port.query(...)
    // directly rather than readAll().

    @Test
    void passesThePortsPageOfCallSummariesThroughUnchanged() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query("", "", "newest", 0, 50, true))
                .thenReturn(new CallListSupport.Page<>(List.of(summary("c"), summary("b")), 3));
        CallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(0, 50));

        assertThat(result.calls()).extracting(CallSummary::url).containsExactly("c", "b");
        assertThat(result.total()).isEqualTo(3);
    }

    @Test
    void passesOffsetAndLimitThroughUnchangedWhenWithinBounds() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        CallsService service = serviceWith(port);

        service.getCalls(query(2, 2));

        verify(port).query("", "", "newest", 2, 2, true);
    }

    @Test
    void clampsANegativeOffsetUpToZero() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        CallsService service = serviceWith(port);

        service.getCalls(query(-5, 2));

        verify(port).query("", "", "newest", 0, 2, true);
    }

    @Test
    void clampsALimitBelowOneUpToOne() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        CallsService service = serviceWith(port);

        service.getCalls(query(0, 0));
        service.getCalls(query(0, -5));

        verify(port, org.mockito.Mockito.times(2)).query("", "", "newest", 0, 1, true);
    }

    @Test
    void clampsALimitAboveTheMaximum() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        CallsService service = serviceWith(port);

        service.getCalls(query(0, TEST_MAX_LIMIT + 50));

        verify(port).query("", "", "newest", 0, TEST_MAX_LIMIT, true);
    }

    @Test
    void disabledPaginationIgnoresTheRequestedLimitAndUsesMaxLimitInstead() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.query(anyString(), anyString(), anyString(), anyInt(), anyInt(), anyBoolean()))
                .thenReturn(new CallListSupport.Page<>(List.of(), 0));
        CallsService service = serviceWith(port);
        setPaginationEnabled(service, false);

        service.getCalls(query(2, 50));

        verify(port).query("", "", "newest", 2, TEST_MAX_LIMIT, false);
    }

    @Test
    void getDetailDelegatesToFindById() {
        CallLogPort port = mock(CallLogPort.class);
        CallRecord found = call("https://example.com/api/x");
        when(port.findById("id-https://example.com/api/x")).thenReturn(Optional.of(found));
        CallsService service = serviceWith(port);

        assertThat(service.getDetail("id-https://example.com/api/x")).isPresent();
        assertThat(service.getDetail("missing")).isEmpty();
    }

    @Test
    void receiveNewCallSavesThenFansOutToObserversThenBroadcastsWithTheirIds() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewCallObserverPort observerA = mock(NewCallObserverPort.class);
        NewCallObserverPort observerB = mock(NewCallObserverPort.class);
        CallRecord call = call("https://example.com/api/x");
        when(observerA.onNewCall(call)).thenReturn(List.of("cycle-1"));
        when(observerB.onNewCall(call)).thenReturn(List.of("cycle-2"));
        CallsService service = serviceWith(port, notificationPort, List.of(observerA, observerB));

        service.receiveNewCall(call);

        var order = inOrder(port, observerA, observerB, notificationPort);
        order.verify(port).save(call);
        order.verify(observerA).onNewCall(call);
        order.verify(observerB).onNewCall(call);
        order.verify(notificationPort).notifyNewCall(call, List.of("cycle-1", "cycle-2"));
    }

    @Test
    void receiveNewCallAssignsAnIdWhenTheIncomingCallHasNone() {
        // The proxy's webhook payload has no "id" property, so Jackson deserializes it as null -
        // this is what that looks like once it reaches the service.
        CallRecord callWithoutId = new CallRecord(null, "https://example.com-proxy/x", "https://example.com/x", "GET", null, "t", 1.0, null, null);
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallsService service = serviceWith(port, notificationPort, List.of());

        service.receiveNewCall(callWithoutId);

        ArgumentCaptor<CallRecord> saved = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).save(saved.capture());
        assertThat(saved.getValue().id()).isNotBlank();
        assertThat(saved.getValue().url()).isEqualTo("https://example.com/x");
    }

    @Test
    void receiveNewCallKeepsAnExistingIdUnchanged() {
        CallRecord callWithId = call("https://example.com/api/x");
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallsService service = serviceWith(port, notificationPort, List.of());

        service.receiveNewCall(callWithId);

        verify(port).save(callWithId);
    }

    @Test
    void receiveNewCallBroadcastsAnEmptyListWhenThereAreNoObservers() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord call = call("https://example.com/api/x");
        CallsService service = serviceWith(port, notificationPort, List.of());

        service.receiveNewCall(call);

        inOrder(port, notificationPort).verify(notificationPort).notifyNewCall(call, List.of());
    }

    @Test
    void receiveNewCallSkipsPersistenceAndBroadcastWhenTheFilterPortRejectsTheCall() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewCallObserverPort observer = mock(NewCallObserverPort.class);
        CallFilterPort filterPort = mock(CallFilterPort.class);
        CallRecord call = call("https://blocked.com/api/x");
        when(filterPort.isAllowed(call)).thenReturn(false);
        CallsService service = serviceWith(port, notificationPort, List.of(observer), Optional.of(filterPort));

        service.receiveNewCall(call);

        verify(port, never()).save(call);
        verifyNoInteractions(observer, notificationPort);
    }

    @Test
    void receiveNewCallProceedsAsUsualWhenTheFilterPortAllowsTheCall() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallFilterPort filterPort = mock(CallFilterPort.class);
        CallRecord call = call("https://allowed.com/api/x");
        when(filterPort.isAllowed(call)).thenReturn(true);
        CallsService service = serviceWith(port, notificationPort, List.of(), Optional.of(filterPort));

        service.receiveNewCall(call);

        verify(port).save(call);
        verify(notificationPort).notifyNewCall(call, List.of());
    }

    @Test
    void receivePreparedCallAssignsAnIdSavesItInProgressAndFansOutToObserversBeforeNotifying() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewCallObserverPort observer = mock(NewCallObserverPort.class);
        CallRecord partial = new CallRecord(null, "https://example.com-proxy/x", "https://example.com/x", "GET", null, "t", null, null, null, null);
        when(observer.onCallPrepared(org.mockito.ArgumentMatchers.any())).thenReturn(List.of("cycle-1"));
        CallsService service = serviceWith(port, notificationPort, List.of(observer));

        Optional<String> id = service.receivePreparedCall(partial);

        assertThat(id).isPresent();
        ArgumentCaptor<CallRecord> prepared = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).prepare(prepared.capture());
        assertThat(prepared.getValue().id()).isEqualTo(id.get());
        assertThat(prepared.getValue().state()).isEqualTo(CallLifecycleStatus.IN_PROGRESS);
        assertThat(prepared.getValue().response()).isNull();
        var order = inOrder(port, observer, notificationPort);
        order.verify(port).prepare(prepared.getValue());
        order.verify(observer).onCallPrepared(prepared.getValue());
        order.verify(notificationPort).notifyCallPrepared(prepared.getValue(), List.of("cycle-1"));
    }

    @Test
    void receivePreparedCallUsesTheProxySuppliedIdInsteadOfGeneratingOne() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord partial = new CallRecord("proxy-generated-id", "https://example.com-proxy/x", "https://example.com/x", "GET", null, "t", null, null, null, null);
        CallsService service = serviceWith(port, notificationPort, List.of());

        Optional<String> id = service.receivePreparedCall(partial);

        assertThat(id).contains("proxy-generated-id");
        ArgumentCaptor<CallRecord> prepared = ArgumentCaptor.forClass(CallRecord.class);
        verify(port).prepare(prepared.capture());
        assertThat(prepared.getValue().id()).isEqualTo("proxy-generated-id");
    }

    @Test
    void receivePreparedCallReturnsEmptyAndSkipsPersistenceWhenTheFilterPortRejectsTheCall() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallFilterPort filterPort = mock(CallFilterPort.class);
        when(filterPort.isAllowed(org.mockito.ArgumentMatchers.any())).thenReturn(false);
        CallRecord partial = new CallRecord(null, "https://blocked.com-proxy/x", "https://blocked.com/x", "GET", null, "t", null, null, null, null);
        CallsService service = serviceWith(port, notificationPort, List.of(), Optional.of(filterPort));

        Optional<String> id = service.receivePreparedCall(partial);

        assertThat(id).isEmpty();
        verify(port, never()).prepare(org.mockito.ArgumentMatchers.any());
        verifyNoInteractions(notificationPort);
    }

    @Test
    void receiveCompletedCallUpdatesFansOutAndNotifiesInOrder() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewCallObserverPort observer = mock(NewCallObserverPort.class);
        CallRecord completed = call("https://example.com/api/x");
        ResponseData response = new ResponseData(200, null, "{}");
        when(port.complete("call-1", response, null, 42.0)).thenReturn(true);
        when(port.findById("call-1")).thenReturn(Optional.of(completed));
        when(observer.onCallCompleted(completed)).thenReturn(List.of("cycle-1"));
        CallsService service = serviceWith(port, notificationPort, List.of(observer));

        boolean result = service.receiveCompletedCall("call-1", response, null, 42.0);

        assertThat(result).isTrue();
        var order = inOrder(port, observer, notificationPort);
        order.verify(port).complete("call-1", response, null, 42.0);
        order.verify(port).findById("call-1");
        order.verify(observer).onCallCompleted(completed);
        order.verify(notificationPort).notifyCallCompleted(completed, List.of("cycle-1"));
    }

    @Test
    void receiveCompletedCallReturnsFalseAndSkipsFanOutWhenThePortReportsTheCallWasNeverPrepared() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        NewCallObserverPort observer = mock(NewCallObserverPort.class);
        when(port.complete("missing", null, "timeout", null)).thenReturn(false);
        CallsService service = serviceWith(port, notificationPort, List.of(observer));

        boolean result = service.receiveCompletedCall("missing", null, "timeout", null);

        assertThat(result).isFalse();
        verify(port, never()).findById(org.mockito.ArgumentMatchers.any());
        verifyNoInteractions(observer, notificationPort);
    }
}
