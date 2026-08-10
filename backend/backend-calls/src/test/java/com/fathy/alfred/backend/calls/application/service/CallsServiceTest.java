package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.application.port.out.CallLogPort;
import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CallsServiceTest {

    private static final int TEST_MAX_LIMIT = 500;

    private static CallRecord call(String url) {
        return new CallRecord(url, url, "GET", null, "t", 1.0, null, null);
    }

    private static CallsQuery query(int offset, int limit) {
        return new CallsQuery("", "", "newest", offset, limit);
    }

    private static CallsService serviceWith(CallLogPort port) {
        return serviceWith(port, mock(CallNotificationPort.class), List.of());
    }

    private static CallsService serviceWith(CallLogPort port, CallNotificationPort notificationPort, List<NewCallObserverPort> observers) {
        CallsService service = new CallsService(port, notificationPort, observers);
        setMaxLimit(service, TEST_MAX_LIMIT);
        return service;
    }

    /** maxLimit is @Value-injected by Spring in production; unit tests construct CallsService directly, so it's set the same way FileCallLogAdapterTest sets its own @Value fields. */
    private static void setMaxLimit(CallsService service, int maxLimit) {
        try {
            Field field = CallsService.class.getDeclaredField("maxLimit");
            field.setAccessible(true);
            field.setInt(service, maxLimit);
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void returnsNewestFirst() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(0, 50));

        assertThat(result.calls()).extracting(CallRecord::url).containsExactly("c", "b", "a");
        assertThat(result.total()).isEqualTo(3);
    }

    @Test
    void limitsToTheRequestedCount() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(0, 2));

        assertThat(result.calls()).extracting(CallRecord::url).containsExactly("c", "b");
        assertThat(result.total()).isEqualTo(3);
    }

    @Test
    void offsetsPastAlreadyLoadedCalls() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(2, 2));

        assertThat(result.calls()).extracting(CallRecord::url).containsExactly("a");
        assertThat(result.total()).isEqualTo(3);
    }

    @Test
    void clampsALimitBelowOneUpToOne() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b")));
        CallsService service = serviceWith(port);

        assertThat(service.getCalls(query(0, 0)).calls()).hasSize(1);
        assertThat(service.getCalls(query(0, -5)).calls()).hasSize(1);
    }

    @Test
    void clampsALimitAboveTheMaximum() {
        CallLogPort port = mock(CallLogPort.class);
        List<CallRecord> many = java.util.stream.IntStream.range(0, TEST_MAX_LIMIT + 50)
                .mapToObj(i -> call("call-" + i))
                .toList();
        when(port.readAll()).thenReturn(many);
        CallsService service = serviceWith(port);

        CallsPage result = service.getCalls(query(0, TEST_MAX_LIMIT + 50));

        assertThat(result.calls()).hasSize(TEST_MAX_LIMIT);
        assertThat(result.total()).isEqualTo(TEST_MAX_LIMIT + 50);
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
    void receiveNewCallBroadcastsAnEmptyListWhenThereAreNoObservers() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallRecord call = call("https://example.com/api/x");
        CallsService service = serviceWith(port, notificationPort, List.of());

        service.receiveNewCall(call);

        inOrder(port, notificationPort).verify(notificationPort).notifyNewCall(call, List.of());
    }
}
