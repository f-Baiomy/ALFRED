package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CapturedInternalCallsStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleMetadataStorePort;
import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import com.fathy.alfred.backend.sessioncycles.domain.model.CycleSummary;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class CycleNotesServiceTest {

    private final SessionCycleMetadataStorePort store = mock(SessionCycleMetadataStorePort.class);
    private final SessionCycleNotificationPort notifications = mock(SessionCycleNotificationPort.class);
    private final CycleNotesService service = new CycleNotesService(store, mock(CapturedCallsStorePort.class),
            mock(CapturedInternalCallsStorePort.class), notifications);

    @Test
    void notesAreSetLeftAloneOrClearedAndARenameKeepsThem() {
        SessionCycle cycle = new SessionCycle("c1", "rec", "2026-10-18T12:00:00Z", null, SessionCycleStatus.PAUSED);
        when(store.findById("c1")).thenReturn(Optional.of(cycle));
        when(store.save(any())).thenAnswer(i -> i.getArgument(0));

        SessionCycle written = service.updateNotes("c1", "Re-test after 4f4139a\n- [ ] Search", null).orElseThrow();
        assertThat(written.description()).startsWith("Re-test after");
        assertThat(written.summary()).isNull();
        verify(notifications).notifySessionCyclesChanged();

        when(store.findById("c1")).thenReturn(Optional.of(written));
        SessionCycle both = service.updateNotes("c1", null, "2 of 3 cards pass").orElseThrow();
        assertThat(both.description()).startsWith("Re-test after");
        assertThat(both.summary()).isEqualTo("2 of 3 cards pass");

        assertThat(both.withName("other").withStatus(SessionCycleStatus.RECORDING).description()).startsWith("Re-test after");
        assertThat(both.withNotes("", null).description()).isNull();
        assertThat(both.withNotes("", null).summary()).isEqualTo("2 of 3 cards pass");
    }

    @Test
    void tooLongNotesAreRefusedAndAMissingCycleIsEmpty() {
        assertThatThrownBy(() -> service.updateNotes("c1", "x".repeat(20_001), null)).isInstanceOf(IllegalArgumentException.class);
        when(store.findById("nope")).thenReturn(Optional.empty());
        assertThat(service.updateNotes("nope", "a", null)).isEmpty();
        assertThat(service.summary("nope")).isEmpty();
    }

    @Test
    void theSummaryCountsCallsFailuresEndpointsAndHostsInTimeOrder() {
        List<CycleNotesService.Row> rows = List.of(
                new CycleNotesService.Row("INBOUND", "i2", "2026-10-18T13:17:05Z", "get", "http://env80:8080/api/ancillaries?carrier=G9", 500, 1904.0, null),
                new CycleNotesService.Row("INBOUND", "i1", "2026-10-18T13:16:02Z", "POST", "http://env80:8080/api/search/flights", 200, 812.0, null),
                new CycleNotesService.Row("INBOUND", "i3", "2026-10-18T13:18:00Z", "GET", "http://env80:8080/api/ancillaries?carrier=EK", 200, 600.0, null),
                new CycleNotesService.Row("OUTBOUND", "o1", "2026-10-18T13:16:03Z", "POST", "https://supplier.example/air/search", null, null, "timeout"));

        CycleSummary s = CycleNotesService.summarize("c1", rows);

        assertThat(s.calls()).isEqualTo(4);
        assertThat(s.failed()).isEqualTo(2);
        assertThat(s.firstAt()).isEqualTo("2026-10-18T13:16:02Z");
        assertThat(s.lastAt()).isEqualTo("2026-10-18T13:18:00Z");
        assertThat(s.hosts()).containsExactly("env80:8080", "supplier.example");
        assertThat(s.medianMs()).isEqualTo(812.0);
        assertThat(s.strip()).extracting(CycleSummary.Point::callId).containsExactly("i1", "o1", "i2", "i3");
        assertThat(s.inboundCallIds()).containsExactly("i1", "i2", "i3");
        CycleSummary.Endpoint anc = s.endpoints().stream().filter(e -> e.path().equals("/api/ancillaries")).findFirst().orElseThrow();
        assertThat(anc.method()).isEqualTo("GET");
        assertThat(anc.calls()).isEqualTo(2);
        assertThat(anc.failed()).isEqualTo(1);
        assertThat(anc.lastStatus()).isEqualTo(200);
        assertThat(anc.maxMs()).isEqualTo(1904.0);
    }

    @Test
    void pathsLoseTheirQueryAndHost() {
        assertThat(CycleNotesService.pathOf("http://h:1/a/b?x=1")).isEqualTo("/a/b");
        assertThat(CycleNotesService.pathOf("/a?x")).isEqualTo("/a");
        assertThat(CycleNotesService.pathOf("http://h")).isEqualTo("/");
        assertThat(CycleNotesService.pathOf(null)).isEqualTo("/");
    }
}
