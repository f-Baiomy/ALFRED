package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.dbcapture.application.port.in.FindStatementFailuresUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementFailures;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TriageBridgeTest {

    private final RecordCallAttentionUseCase record = mock(RecordCallAttentionUseCase.class);

    private static com.fathy.alfred.backend.calls.domain.model.CallRecord outbound(String id, String parent, Integer status, String body) {
        return new com.fathy.alfred.backend.calls.domain.model.CallRecord(id, "https://g94/x", "https://g94/x", "POST",
                new RequestData(null, null), "2026-10-05T16:04:57.815289+00:00", 1440.0,
                status == null ? null : new ResponseData(status, null, body), null,
                status == null ? CallLifecycleStatus.IN_PROGRESS : CallLifecycleStatus.COMPLETED,
                null, null, "g94", null, null, null, null, null, true, parent, 3);
    }

    private static com.fathy.alfred.backend.internalcalls.domain.model.CallRecord inbound(String id, Integer status, String body) {
        return new com.fathy.alfred.backend.internalcalls.domain.model.CallRecord(id, "http://wildfly/search", "http://wildfly/search", "POST",
                new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(null, null), "2026-10-05T16:04:40+00:00", 20035.0,
                status == null ? null : new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(status, null, body), null,
                status == null ? com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.IN_PROGRESS
                        : com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED,
                null, null, "odeysys");
    }

    @Test
    void everyCallIsHandedOverTranslated_inboundWithItsProject_outboundWithItsParent() {
        TriageCallObserverAdapter adapter = new TriageCallObserverAdapter(record);

        adapter.onCallPrepared(inbound("in-1", null, null));
        adapter.onCallCompleted(inbound("in-1", 200, "{\"offers\":{}}"));
        assertThat(adapter.onCallCompleted(outbound("out-1", "in-1", 200, "<Error Code=\"322\"/>"))).isEmpty();
        adapter.onNewCall(outbound("out-2", null, 503, ""));

        ArgumentCaptor<ObservedCall> captor = ArgumentCaptor.forClass(ObservedCall.class);
        verify(record, times(4)).callObserved(captor.capture());
        List<ObservedCall> calls = captor.getAllValues();
        assertThat(calls.get(0)).isEqualTo(new ObservedCall("in-1", CallDirection.INBOUND, "odeysys", null, "POST", "http://wildfly/search",
                null, null, "2026-10-05T16:04:40+00:00", 20035.0, "IN_PROGRESS", null));
        assertThat(calls.get(1).responseBody()).isEqualTo("{\"offers\":{}}");
        assertThat(calls.get(1).state()).isEqualTo("COMPLETED");
        assertThat(calls.get(2).direction()).isEqualTo(CallDirection.OUTBOUND);
        assertThat(calls.get(2).parentCallId()).isEqualTo("in-1");
        assertThat(calls.get(2).project()).isNull();
        assertThat(calls.get(3).status()).isEqualTo(503);
    }

    @Test
    void statementFailuresPassThrough() {
        new TriageStatementFailuresAdapter(record).failuresChanged("in-1", 2, 1);
        verify(record).statementFailures("in-1", 2, 1);
    }

    @Test
    void theBackfillReadsBodiesOnlyWhereTheyCanChangeTheMark_andRunsOnlyOnceAskedTo() {
        var outCalls = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase.class);
        var outRange = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase.class);
        var inCalls = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase.class);
        var inRange = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase.class);
        var outDetail = mock(com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase.class);
        var inDetail = mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase.class);
        ListSessionCyclesUseCase cycles = mock(ListSessionCyclesUseCase.class);
        FindStatementFailuresUseCase failures = mock(FindStatementFailuresUseCase.class);

        var outSummary = com.fathy.alfred.backend.calls.domain.model.CallSummary.of(outbound("out-1", null, 200, null));
        when(outCalls.getCalls(any())).thenReturn(new com.fathy.alfred.backend.calls.domain.model.CallsPage(List.of(outSummary), 1));
        // A range read carries no bodies: the 200 needs its body read, the 503 does not.
        when(outRange.getCallsInRange(any(Instant.class), any(Instant.class), anyString(), anyString()))
                .thenReturn(List.of(outbound("out-1", null, 200, null), outbound("out-2", null, 503, null)));
        when(outDetail.getDetail("out-1")).thenReturn(Optional.of(new com.fathy.alfred.backend.calls.domain.model.CallDetail(null,
                new ResponseData(200, null, "<Error Code=\"322\"/>"))));
        var inSummary = com.fathy.alfred.backend.internalcalls.domain.model.CallSummary.of(inbound("in-1", 200, null));
        when(inCalls.getCalls(any())).thenReturn(new com.fathy.alfred.backend.internalcalls.domain.model.CallsPage(List.of(inSummary), 1));
        when(inRange.getCallsInRange(any(Instant.class), any(Instant.class), anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenReturn(List.of(inbound("in-1", 200, "{}")));
        when(cycles.listAll()).thenReturn(List.of());
        when(failures.failures(anyList())).thenReturn(Map.of("in-1", new CallStatementFailures("in-1", 1, 1, List.of())));

        TriageBackfill backfill = new TriageBackfill(record, outCalls, outRange, inCalls, inRange, cycles, mock(ListCapturedCallsUseCase.class),
                mock(ListPagedCapturedInternalCallsUseCase.class), mock(GetCapturedCallDetailUseCase.class),
                mock(GetCapturedInternalCallDetailUseCase.class), failures, outDetail, inDetail);
        backfill.run();

        ArgumentCaptor<ObservedCall> captor = ArgumentCaptor.forClass(ObservedCall.class);
        verify(record, times(3)).callObserved(captor.capture());
        assertThat(captor.getAllValues()).extracting(ObservedCall::callId).containsExactly("out-1", "out-2", "in-1");
        assertThat(captor.getAllValues().get(0).responseBody()).isEqualTo("<Error Code=\"322\"/>");
        verify(outDetail, never()).getDetail("out-2");
        verify(inDetail, never()).getDetail(anyString());
        verify(record).statementFailures("in-1", 1, 1);
        verify(record).backfillDone(3);
    }

    @Test
    void dbCapturesSignalsReachTheMarkAndCallsCopiedIntoACycleGetMarksToo() {
        new TriageCallSignalsAdapter(record).signalsChanged("in-9", 5, 1, 2, "CAUGHT", "WARN", List.of("SLOW"));
        verify(record).signals("in-9", new com.fathy.alfred.backend.triage.domain.model.CallSignals(5, 1, 2, "CAUGHT", "WARN", List.of("SLOW")));

        TriageImportFeed feed = new TriageImportFeed(record);
        feed.inboundCopied("cycle-1", List.of(inbound("imp-in", 200, "{}")));
        feed.outboundCopied("cycle-1", List.of(outbound("imp-out", "imp-in", 503, "down")));
        ArgumentCaptor<ObservedCall> seen = ArgumentCaptor.forClass(ObservedCall.class);
        verify(record, times(2)).callObserved(seen.capture());
        assertThat(seen.getAllValues()).extracting(ObservedCall::callId).containsExactly("imp-in", "imp-out");
        assertThat(seen.getAllValues().get(1).parentCallId()).isEqualTo("imp-in");
    }

    @Test
    void signalsOfCallsCapturedBeforeThisVersionAreFedOnce() {
        com.fathy.alfred.backend.dbcapture.application.port.in.RepublishCallSignalsUseCase republish =
                mock(com.fathy.alfred.backend.dbcapture.application.port.in.RepublishCallSignalsUseCase.class);
        when(republish.republishAll()).thenReturn(42);
        when(record.signalsBackfillNeeded()).thenReturn(true);

        new TriageSignalsBackfill(record, republish).run();
        verify(record).signalsBackfillDone(42);

        when(republish.republishAll()).thenThrow(new IllegalStateException("db gone"));
        new TriageSignalsBackfill(record, republish).run();
        verify(record, times(1)).signalsBackfillDone(org.mockito.ArgumentMatchers.anyInt()); // a failure is not marked done
    }
}
