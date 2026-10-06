package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.logs.domain.model.KeptLogLine;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CycleLogsKeeperTest {

    private final CallLogsService callLogs = mock(CallLogsService.class);
    private final ListSessionCyclesUseCase cycles = mock(ListSessionCyclesUseCase.class);
    private final ListCapturedInternalCallsUseCase cycleCalls = mock(ListCapturedInternalCallsUseCase.class);
    private final CycleLogsKeeper keeper = new CycleLogsKeeper(callLogs, cycles, cycleCalls);

    @Test
    void keepsEveryCallOfTheChangedCycle() {
        holds("cy1", "a", "b");
        when(callLogs.keepForCycle(anyString(), eq("cy1"))).thenReturn(3);

        assertThat(keeper.keepCycle("cy1")).isEqualTo(6);
        verify(callLogs).keepForCycle("a", "cy1");
        verify(callLogs).keepForCycle("b", "cy1");
    }

    @Test
    void sweepDropsKeptLinesNothingHoldsAndKeepsAStoppedRecording() {
        holds("cy1", "a");
        when(cycles.listAll()).thenReturn(List.of(cycle("cy1", SessionCycleStatus.RECORDING)));
        when(callLogs.callsWithKept(KeptLogLine.Origin.CYCLE, 50_000)).thenReturn(List.of("a", "gone"));
        when(callLogs.callsWithKept(KeptLogLine.Origin.IMPORT, 50_000)).thenReturn(List.of("imp-live", "imp-gone"));
        when(callLogs.isLiveCall("imp-live")).thenReturn(true);

        keeper.sweep();
        verify(callLogs).forget(List.of("gone"), KeptLogLine.Origin.CYCLE);
        verify(callLogs).forget(List.of("imp-gone"), KeptLogLine.Origin.IMPORT);
        verify(callLogs, never()).keepForCycle(anyString(), anyString());

        when(cycles.listAll()).thenReturn(List.of(cycle("cy1", SessionCycleStatus.PAUSED)));
        keeper.sweep();
        verify(callLogs).keepForCycle("a", "cy1");
    }

    @Test
    void aRecordingRunningAtStartUpIsKeptWhenItStops() {
        holds("cy1", "a");
        when(cycles.listAll()).thenReturn(List.of(cycle("cy1", SessionCycleStatus.RECORDING)));
        keeper.noteStatuses(); // what start-up does

        when(cycles.listAll()).thenReturn(List.of(cycle("cy1", SessionCycleStatus.PAUSED)));
        keeper.sweep(); // the first sweep after the restart is the stop itself

        verify(callLogs).keepForCycle("a", "cy1");
    }

    @Test
    @SuppressWarnings("unchecked")
    void theDecoratorStillBroadcastsAndThenKeeps() {
        SessionCycleNotificationPort socket = mock(SessionCycleNotificationPort.class);
        CycleLogsKeeper k = mock(CycleLogsKeeper.class);
        ObjectProvider<CycleLogsKeeper> provider = mock(ObjectProvider.class);
        doAnswer(inv -> {
            ((Consumer<CycleLogsKeeper>) inv.getArgument(0)).accept(k);
            return null;
        }).when(provider).ifAvailable(any());
        CycleContentKeepDecorator decorator = new CycleContentKeepDecorator(socket, provider);

        decorator.notifyCycleContentChanged("cy1");
        decorator.notifySessionCyclesChanged();

        verify(socket).notifyCycleContentChanged("cy1");
        verify(socket).notifySessionCyclesChanged();
        verify(k).cycleChanged("cy1");
        verify(k).cyclesChanged();
    }

    private void holds(String cycleId, String... callIds) {
        List<CapturedInternalCallSummary> calls = java.util.Arrays.stream(callIds)
                .map(id -> new CapturedInternalCallSummary("cap-" + id, "2026-10-06T10:00:00Z",
                        new CallSummary(id, "/x", "/x", "GET", "2026-10-06T10:00:00Z", 1.0, 200, null, null, null, null, null, "odeysys", null)))
                .toList();
        when(cycleCalls.listCalls(eq(cycleId), any())).thenReturn(Optional.of(new CapturedInternalCallsPage(calls, calls.size())));
    }

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, id, "2026-10-06T10:00:00Z", null, status);
    }
}
