package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogCounts;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** specs/017 R17-R18: the calls a snippet reads - narrowed, newest first, with what capture recorded. */
class BoardDataControllerTest {

    private final GetCallsUseCase inbound = mock(GetCallsUseCase.class);
    private final GetCallDbSummariesUseCase db = mock(GetCallDbSummariesUseCase.class);
    private final CallLogLinesUseCase logs = mock(CallLogLinesUseCase.class);
    private final NormalizeEndpointUseCase endpoints = mock(NormalizeEndpointUseCase.class);
    private final BoardDataController controller;

    BoardDataControllerTest() {
        when(endpoints.endpointOf(any(), any())).thenAnswer(i -> i.getArgument(0) + " " + java.net.URI.create(i.getArgument(1)).getPath()
                .replaceAll("/\\d+", "/{n}"));
        BoardCycleCallsAdapter signer = new BoardCycleCallsAdapter(mock(ListCapturedCallsUseCase.class), mock(ListPagedCapturedInternalCallsUseCase.class),
                endpoints, inbound, new org.springframework.beans.factory.support.StaticListableBeanFactory()
                        .getBeanProvider(com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase.class),
                new org.springframework.beans.factory.support.StaticListableBeanFactory()
                        .getBeanProvider(com.fathy.alfred.backend.linksbridge.RemoteBoardData.class));
        controller = new BoardDataController(inbound, mock(ListCapturedCallsUseCase.class), mock(ListPagedCapturedInternalCallsUseCase.class), signer,
                db, logs);
    }

    private static CallSummary call(String id, String method, String path, int status, String at, double ms) {
        return new CallSummary(id, "http://app" + path, "http://app" + path, method, at, ms, status, null, null, null, null, null, "odeysys");
    }

    @SuppressWarnings("unchecked")
    private List<BoardDataController.CallRow> rows(Object body) {
        return (List<BoardDataController.CallRow>) ((Map<String, Object>) body).get("calls");
    }

    @Test
    void narrowsByEndpointTimeAndSignalAndAddsWhatCaptureRecorded() {
        when(inbound.getCalls(any())).thenReturn(new CallsPage(List.of(
                call("c4", "POST", "/fare/7", 500, "2026-10-14T10:04:00Z", 2400),
                call("c3", "GET", "/fare/7", 200, "2026-10-14T10:03:00Z", 90),
                call("c2", "POST", "/fare/6", 200, "2026-10-14T10:02:00Z", 610),
                call("c1", "POST", "/fare/5", 200, "2026-10-14T09:00:00Z", 700)), 4));
        when(db.summaries(anyList())).thenReturn(Map.of("c4", new CallDbSummary("c4", 12, 2, 0, 1, 1, 0, 108_000, 0, List.of(), 12, true, false)));
        when(logs.counts(anyList())).thenReturn(Map.of("c4", new CaughtLogCounts(5, 1, 2, 0, 1)));

        var body = controller.calls("odeysys", "POST /fare", "2026-10-14T10:00:00Z", null, null, null, null).getBody();

        assertThat(rows(body)).extracting(BoardDataController.CallRow::ref).containsExactly("in:c4", "in:c2");
        var first = rows(body).get(0);
        assertThat(first.endpoint()).isEqualTo("POST /fare/{n}");
        assertThat(first.signal()).isEqualTo("5xx");
        assertThat(first.statements()).isEqualTo(12);
        assertThat(first.failedStatements()).isEqualTo(1);
        assertThat(first.dbMs()).isEqualTo(108.0);
        assertThat(first.errors()).isEqualTo(1);
        assertThat(first.project()).isEqualTo("odeysys");
        assertThat(rows(body).get(1).statements()).as("not captured: unknown, never 0").isNull();

        var errors = controller.calls(null, null, null, null, null, "5xx", null).getBody();
        assertThat(rows(errors)).extracting(BoardDataController.CallRow::ref).containsExactly("in:c4");

        ArgumentCaptor<CallsQuery> q = ArgumentCaptor.forClass(CallsQuery.class);
        verify(inbound, org.mockito.Mockito.atLeastOnce()).getCalls(q.capture());
        assertThat(q.getAllValues().get(0).serviceNames()).isEqualTo("odeysys");
        assertThat(q.getAllValues().get(0).sort()).isEqualTo("newest");
    }

    @Test
    void aBadTimeIsRefusedAndTheLimitIsKept() {
        assertThat(controller.calls(null, null, "yesterday", null, null, null, null).getStatusCode().value()).isEqualTo(400);
        when(inbound.getCalls(any())).thenReturn(new CallsPage(List.of(
                call("a", "GET", "/x", 200, "2026-10-14T10:04:00Z", 1), call("b", "GET", "/x", 200, "2026-10-14T10:03:00Z", 1)), 2));
        when(db.summaries(anyList())).thenReturn(Map.of());
        when(logs.counts(anyList())).thenReturn(Map.of());
        var body = (Map<?, ?>) controller.calls(null, null, null, null, null, null, 1).getBody();
        assertThat(rows(body)).hasSize(1);
        assertThat(body.get("truncated")).isEqualTo(true);
    }
}
