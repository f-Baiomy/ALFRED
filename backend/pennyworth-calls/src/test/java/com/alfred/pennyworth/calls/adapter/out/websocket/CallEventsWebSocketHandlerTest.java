package com.alfred.pennyworth.calls.adapter.out.websocket;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CallEventsWebSocketHandlerTest {

    private final CallEventsWebSocketHandler handler = new CallEventsWebSocketHandler();

    private static WebSocketSession openSession() throws IOException {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        return session;
    }

    @Test
    void broadcastsToEveryOpenSession() throws Exception {
        WebSocketSession a = openSession();
        WebSocketSession b = openSession();
        handler.afterConnectionEstablished(a);
        handler.afterConnectionEstablished(b);

        handler.broadcast("{\"hello\":true}");

        verify(a).sendMessage(new TextMessage("{\"hello\":true}"));
        verify(b).sendMessage(new TextMessage("{\"hello\":true}"));
    }

    @Test
    void doesNotSendToASessionRemovedAfterClose() throws Exception {
        WebSocketSession a = openSession();
        handler.afterConnectionEstablished(a);
        handler.afterConnectionClosed(a, null);

        handler.broadcast("{\"hello\":true}");

        verify(a, org.mockito.Mockito.never()).sendMessage(any());
    }

    @Test
    void dropsASessionThatFailsToSendWithoutThrowing() throws Exception {
        WebSocketSession failing = openSession();
        doThrow(new IOException("broken pipe")).when(failing).sendMessage(any());
        handler.afterConnectionEstablished(failing);

        handler.broadcast("{\"hello\":true}");
        handler.broadcast("{\"second\":true}");

        // First broadcast triggers the failure and drops the session; second call proves it's
        // gone (no second sendMessage attempt) and that broadcasting itself never throws.
        verify(failing, org.mockito.Mockito.times(1)).sendMessage(any());
    }

    @Test
    void skipsSessionsThatAreNoLongerOpen() throws Exception {
        WebSocketSession closed = mock(WebSocketSession.class);
        when(closed.isOpen()).thenReturn(false);
        handler.afterConnectionEstablished(closed);

        handler.broadcast("{\"hello\":true}");

        verify(closed, org.mockito.Mockito.never()).sendMessage(any());
    }
}
