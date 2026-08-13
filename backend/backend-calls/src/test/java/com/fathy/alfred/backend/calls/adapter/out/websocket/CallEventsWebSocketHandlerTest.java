package com.fathy.alfred.backend.calls.adapter.out.websocket;

import org.junit.jupiter.api.Test;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
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

    @Test
    void dropsASessionThatThrowsIllegalStateExceptionWithoutThrowing() throws Exception {
        // Regression test: WebSocketSession.sendMessage throws IllegalStateException (not
        // IOException) when called concurrently for the same session from two threads - a real
        // exception observed in production once two-phase logging doubled how often a call
        // broadcasts (prepare + complete). Must be caught and the session dropped, same as an
        // IOException, not left to propagate and fail the whole webhook request.
        WebSocketSession failing = openSession();
        doThrow(new IllegalStateException("TEXT_PARTIAL_WRITING")).when(failing).sendMessage(any());
        handler.afterConnectionEstablished(failing);

        handler.broadcast("{\"hello\":true}");
        handler.broadcast("{\"second\":true}");

        verify(failing, org.mockito.Mockito.times(1)).sendMessage(any());
    }

    @Test
    void neverSendsToTheSameSessionConcurrentlyFromTwoThreads() throws Exception {
        // Regression test for the actual production bug: two threads (e.g. a prepare-call request
        // and a complete-call request for a different call, handled concurrently) broadcasting at
        // the same time must never call sendMessage on the same session simultaneously - the real
        // WebSocketSession implementation throws IllegalStateException if they do.
        WebSocketSession session = openSession();
        AtomicInteger concurrentSenders = new AtomicInteger(0);
        AtomicInteger maxObservedConcurrency = new AtomicInteger(0);
        doAnswer(invocation -> {
            int current = concurrentSenders.incrementAndGet();
            maxObservedConcurrency.updateAndGet(max -> Math.max(max, current));
            Thread.sleep(5); // widen the race window so a real bug would reliably be caught
            concurrentSenders.decrementAndGet();
            return null;
        }).when(session).sendMessage(any());
        handler.afterConnectionEstablished(session);

        int threadCount = 8;
        ExecutorService executor = Executors.newFixedThreadPool(threadCount);
        CountDownLatch ready = new CountDownLatch(threadCount);
        CountDownLatch go = new CountDownLatch(1);
        try {
            for (int i = 0; i < threadCount; i++) {
                executor.submit(() -> {
                    ready.countDown();
                    try {
                        go.await();
                        handler.broadcast("{\"n\":true}");
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
            ready.await();
            go.countDown();
            executor.shutdown();
            assertThat(executor.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
        } finally {
            executor.shutdownNow();
        }

        assertThat(maxObservedConcurrency.get()).isEqualTo(1);
        verify(session, org.mockito.Mockito.times(threadCount)).sendMessage(any());
    }
}
