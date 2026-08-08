package com.alfred.pennyworth.calls.adapter.out.websocket;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class WebSocketCallNotificationAdapterTest {

    @Test
    void serializesTheCallEventAndBroadcastsIt() {
        CallEventsWebSocketHandler handler = mock(CallEventsWebSocketHandler.class);
        WebSocketCallNotificationAdapter adapter = new WebSocketCallNotificationAdapter(handler);
        CallRecord call = new CallRecord("https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);

        adapter.notifyNewCall(call, List.of("cycle-1", "cycle-2"));

        verify(handler).broadcast(contains("\"url\":\"https://a.com/x\""));
        verify(handler).broadcast(contains("\"capturedByCycleIds\":[\"cycle-1\",\"cycle-2\"]"));
    }

    @Test
    void broadcastsAnEmptyCapturedByListWhenNoCycleCapturedTheCall() {
        CallEventsWebSocketHandler handler = mock(CallEventsWebSocketHandler.class);
        WebSocketCallNotificationAdapter adapter = new WebSocketCallNotificationAdapter(handler);
        CallRecord call = new CallRecord("https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);

        adapter.notifyNewCall(call, List.of());

        verify(handler).broadcast(contains("\"capturedByCycleIds\":[]"));
    }
}
