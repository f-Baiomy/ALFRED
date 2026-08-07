package com.alfred.pennyworth.calls.application.service;

import com.alfred.pennyworth.calls.application.port.out.CallLogPort;
import com.alfred.pennyworth.calls.application.port.out.CallNotificationPort;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CallsServiceTest {

    private static CallRecord call(String url) {
        return new CallRecord(url, url, "GET", null, "t", 1.0, null, null);
    }

    private static CallsService serviceWith(CallLogPort port) {
        return new CallsService(port, mock(CallNotificationPort.class));
    }

    @Test
    void returnsNewestFirst() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = serviceWith(port);

        List<CallRecord> result = service.getCalls(50);

        assertThat(result).extracting(CallRecord::url).containsExactly("c", "b", "a");
    }

    @Test
    void limitsToTheRequestedCount() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = serviceWith(port);

        List<CallRecord> result = service.getCalls(2);

        assertThat(result).extracting(CallRecord::url).containsExactly("c", "b");
    }

    @Test
    void clampsALimitBelowOneUpToOne() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b")));
        CallsService service = serviceWith(port);

        assertThat(service.getCalls(0)).hasSize(1);
        assertThat(service.getCalls(-5)).hasSize(1);
    }

    @Test
    void clampsALimitAboveTheMaximum() {
        CallLogPort port = mock(CallLogPort.class);
        List<CallRecord> many = java.util.stream.IntStream.range(0, CallsService.MAX_LIMIT + 50)
                .mapToObj(i -> call("call-" + i))
                .toList();
        when(port.readAll()).thenReturn(many);
        CallsService service = serviceWith(port);

        List<CallRecord> result = service.getCalls(CallsService.MAX_LIMIT + 50);

        assertThat(result).hasSize(CallsService.MAX_LIMIT);
    }

    @Test
    void receiveNewCallForwardsToTheNotificationPort() {
        CallLogPort port = mock(CallLogPort.class);
        CallNotificationPort notificationPort = mock(CallNotificationPort.class);
        CallsService service = new CallsService(port, notificationPort);
        CallRecord call = call("https://example.com/api/x");

        service.receiveNewCall(call);

        verify(notificationPort).notifyNewCall(call);
    }
}
