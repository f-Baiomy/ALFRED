package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.calls.application.port.in.FindReliveRunCallsUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.application.port.in.FindInternalReliveRunCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CopyInternalCallsToCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleSpacersStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.domain.model.ReliveRunCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ReliveRunCyclesServiceTest {

    private final Map<String, SessionCycle> cycles = new LinkedHashMap<>();
    private final SessionCycleMetadataStorePort metadataStore = new SessionCycleMetadataStorePort() {
        @Override public List<SessionCycle> findAll() { return new ArrayList<>(cycles.values()); }
        @Override public Optional<SessionCycle> findById(String id) { return Optional.ofNullable(cycles.get(id)); }
        @Override public SessionCycle save(SessionCycle cycle) { cycles.put(cycle.id(), cycle); return cycle; }
        @Override public boolean deleteById(String id) { return cycles.remove(id) != null; }
        @Override public void deleteAll() { cycles.clear(); }
    };
    private final CapturedCallsStorePort capturedCalls = mock(CapturedCallsStorePort.class);
    private final CapturedInternalCallsStorePort capturedInternalCalls = mock(CapturedInternalCallsStorePort.class);
    private final CycleSpacersStorePort spacers = mock(CycleSpacersStorePort.class);
    private final FindReliveRunCallsUseCase outbound = mock(FindReliveRunCallsUseCase.class);
    private final FindInternalReliveRunCallsUseCase inbound = mock(FindInternalReliveRunCallsUseCase.class);
    private final CopyCallsToCycleUseCase copyOutbound = mock(CopyCallsToCycleUseCase.class);
    private final CopyInternalCallsToCycleUseCase copyInbound = mock(CopyInternalCallsToCycleUseCase.class);
    private final ReliveRunCyclesService service = new ReliveRunCyclesService(metadataStore, capturedCalls, capturedInternalCalls,
            spacers, outbound, inbound, copyOutbound, copyInbound);

    @Test
    void theFirstCallOfARunCreatesItsPausedCycleOnceAndNothingIsCopied() {
        String first = service.captureCycleId("run-1234567890");
        String second = service.captureCycleId("run-1234567890");

        assertThat(second).isEqualTo(first);
        SessionCycle cycle = cycles.get(first);
        assertThat(cycle.status()).isEqualTo(SessionCycleStatus.PAUSED);
        assertThat(cycle.reliveRunId()).isEqualTo("run-1234567890");
        assertThat(cycle.name()).isEqualTo("Relive run run-1234");
        verify(copyOutbound, never()).copyInto(anyString(), any());
    }

    @Test
    void openingARunWithoutACycleFillsItFromTheCallLogs() {
        List<CallRecord> logged = List.of(new CallRecord("c-1", "u", "u", "GET", null, "t", 1.0, null, null));
        when(outbound.findByRunId("run-old")).thenReturn(logged);
        when(inbound.findByRunId("run-old")).thenReturn(List.of());

        ReliveRunCycle opened = service.open("run-old", "Run calls · Login · Oct 3", "relive-cycle-1");

        assertThat(opened.created()).isTrue();
        assertThat(opened.cycle().name()).isEqualTo("Run calls · Login · Oct 3");
        assertThat(opened.cycle().reliveCycleId()).isEqualTo("relive-cycle-1");
        verify(copyOutbound).copyInto(opened.cycle().id(), logged);
        verify(copyInbound).copyInto(opened.cycle().id(), List.of());
    }

    @Test
    void openingARunThatAlreadyHasACycleRenamesItButCopiesNothing() {
        String id = service.captureCycleId("run-2");

        ReliveRunCycle opened = service.open("run-2", "Run calls · Search", "relive-cycle-9");

        assertThat(opened.created()).isFalse();
        assertThat(opened.cycle().id()).isEqualTo(id);
        assertThat(cycles.get(id).name()).isEqualTo("Run calls · Search");
        verify(copyOutbound, never()).copyInto(anyString(), any());
    }

    @Test
    void deletingRunsDeletesOnlyTheirCyclesWithEverythingCaptured() {
        String gone = service.captureCycleId("run-a");
        String kept = service.captureCycleId("run-b");
        metadataStore.save(new SessionCycle("ordinary", "Mine", "t", null, SessionCycleStatus.RECORDING));

        assertThat(service.deleteForRuns(List.of("run-a"))).isEqualTo(1);

        assertThat(cycles).containsOnlyKeys(kept, "ordinary");
        verify(capturedCalls).deleteAllForCycle(gone);
        verify(capturedInternalCalls).deleteAllForCycle(gone);
        verify(spacers).deleteAllForCycle(gone);
    }
}
