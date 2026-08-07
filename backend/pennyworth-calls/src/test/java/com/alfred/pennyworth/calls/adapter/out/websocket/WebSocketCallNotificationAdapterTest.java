package com.alfred.pennyworth.calls.adapter.out.websocket;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import org.junit.jupiter.api.Test;

import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class WebSocketCallNotificationAdapterTest {

    @Test
    void serializesTheCallAndBroadcastsIt() {
        CallEventsWebSocketHandler handler = mock(CallEventsWebSocketHandler.class);
        WebSocketCallNotificationAdapter adapter = new WebSocketCallNotificationAdapter(handler);
        CallRecord call = new CallRecord("https://a.com-proxy/x", "https://a.com/x", "GET", null, "t", 1.0, null, null);

        adapter.notifyNewCall(call);

        verify(handler).broadcast(contains("\"url\":\"https://a.com/x\""));
    }
}
