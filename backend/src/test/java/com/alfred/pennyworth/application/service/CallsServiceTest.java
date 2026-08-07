package com.alfred.pennyworth.application.service;

import com.alfred.pennyworth.application.port.out.CallLogPort;
import com.alfred.pennyworth.domain.model.CallRecord;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CallsServiceTest {

    private static CallRecord call(String url) {
        return new CallRecord(url, url, "GET", null, "t", 1.0, null, null);
    }

    @Test
    void returnsNewestFirst() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = new CallsService(port);

        List<CallRecord> result = service.getCalls(50);

        assertThat(result).extracting(CallRecord::url).containsExactly("c", "b", "a");
    }

    @Test
    void limitsToTheRequestedCount() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b"), call("c")));
        CallsService service = new CallsService(port);

        List<CallRecord> result = service.getCalls(2);

        assertThat(result).extracting(CallRecord::url).containsExactly("c", "b");
    }

    @Test
    void clampsALimitBelowOneUpToOne() {
        CallLogPort port = mock(CallLogPort.class);
        when(port.readAll()).thenReturn(List.of(call("a"), call("b")));
        CallsService service = new CallsService(port);

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
        CallsService service = new CallsService(port);

        List<CallRecord> result = service.getCalls(CallsService.MAX_LIMIT + 50);

        assertThat(result).hasSize(CallsService.MAX_LIMIT);
    }
}
