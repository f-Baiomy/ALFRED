package com.fathy.alfred.backend.relivebridge;

import com.fathy.alfred.backend.relive.adapter.out.websocket.ReliveEventsWebSocketHandler;
import com.fathy.alfred.backend.relive.application.port.out.ReliveRunStorePort;
import com.fathy.alfred.backend.relive.application.service.ReliveRunsService;
import com.fathy.alfred.backend.relive.application.service.RunLeaseRegistry;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ReliveLeaseBridgeTest {

    @Test
    void relaysLeaseEventsToTheRegistryAndRegistersItself() {
        ReliveRunStorePort runStore = mock(ReliveRunStorePort.class);
        when(runStore.findAllRunning()).thenReturn(List.of());
        ScheduledExecutorService scheduler = mock(ScheduledExecutorService.class);
        when(scheduler.schedule(any(Runnable.class), anyLong(), any(TimeUnit.class)))
                .thenAnswer(invocation -> mock(ScheduledFuture.class));
        ReliveRunsService runsService = mock(ReliveRunsService.class);
        RunLeaseRegistry registry = Mockito.spy(new RunLeaseRegistry(runsService, runStore, scheduler));
        ReliveEventsWebSocketHandler handler = new ReliveEventsWebSocketHandler();

        ReliveLeaseBridge bridge = new ReliveLeaseBridge(registry, handler);

        bridge.onLeaseHeld("r-1", "session-a");
        verify(registry).onLeaseHeld("r-1", "session-a");

        bridge.onSessionClosed("session-a");
        verify(registry).onSessionClosed("session-a");
    }
}
