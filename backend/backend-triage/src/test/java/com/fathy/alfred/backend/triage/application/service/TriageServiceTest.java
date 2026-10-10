package com.fathy.alfred.backend.triage.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.adapter.out.sqlite.SqliteAttentionRepository;
import com.fathy.alfred.backend.triage.application.port.out.AttentionNotificationPort;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;
import com.fathy.alfred.backend.triage.domain.model.TriageEntry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The service over a real triage.db, writing on the calling thread so every assertion sees the write. */
class TriageServiceTest {

    private static final Instant NOW = Instant.parse("2026-10-05T16:10:00Z");

    @TempDir
    Path tempDir;

    private SqliteAttentionRepository repo;
    private TriageService service;
    private final List<Collection<String>> notified = new ArrayList<>();
    private Set<String> retained = Set.of();

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteAttentionRepository(new ObjectMapper());
        Field field = SqliteAttentionRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("triage.db").toString());
        repo.init();
        AttentionNotificationPort notifications = notified::add;
        service = new TriageService(repo, notifications, () -> retained, Runnable::run, Clock.fixed(NOW, ZoneOffset.UTC), 100);
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private static ObservedCall inbound(String id, Integer status, String body, String startedAt) {
        return new ObservedCall(id, CallDirection.INBOUND, "odeysys", null, "POST", "/odeysysadmin/" + id, status, null, startedAt, 40.0,
                "COMPLETED", body);
    }

    private static ObservedCall supplier(String id, String parent, Integer status, String body) {
        return new ObservedCall(id, CallDirection.OUTBOUND, null, parent, "POST", "https://supplier/" + id, status, null,
                "2026-10-05T16:03:40Z", 90.0, "COMPLETED", body);
    }

    private TriageEntry entry(String id) {
        return service.forCalls(List.of(id), null).get(id);
    }

    @Test
    void everyPriorityGroup() {
        // 1: failed, with a supplier call that failed inside a 200
        service.callObserved(inbound("g1", 500, "{}", "2026-10-05T16:03:35Z"));
        service.callObserved(supplier("g1-s", "g1", 200, "<OTA_AirAvailRS><Errors><Error Code=\"322\" ShortText=\"No availability\"/></Errors></OTA_AirAvailRS>"));
        // 2: failed, with failed statements
        service.callObserved(inbound("g2", 500, "{}", "2026-10-05T16:03:36Z"));
        service.statementFailures("g2", 1, 0);
        // 3: a redirect counts at the default threshold
        service.callObserved(inbound("g3", 307, "", "2026-10-05T16:03:37Z"));
        // 4: succeeded, but a statement failed and was swallowed
        service.callObserved(inbound("g4", 200, "{\"offers\":[{\"id\":1}]}", "2026-10-05T16:03:38Z"));
        service.statementFailures("g4", 1, 1);
        // 5: succeeded with an empty result
        service.callObserved(inbound("g5", 200, "{\"searchOffers\":{\"offers\":{}}}", "2026-10-05T16:03:39Z"));
        // 6: nothing wrong
        service.callObserved(inbound("g6", 200, "{\"offers\":[1]}", "2026-10-05T16:03:40Z"));

        Map<String, TriageEntry> all = service.forCalls(List.of("g1", "g2", "g3", "g4", "g5", "g6"), null);
        assertThat(all).hasSize(6);
        for (int p = 1; p <= 6; p++) {
            assertThat(all.get("g" + p).priority()).as("g" + p).isEqualTo(p);
            assertThat(repo.find("g" + p).orElseThrow().priority()).as("stored g" + p).isEqualTo(p);
        }
        assertThat(all.get("g1").failingSupplierCalls()).singleElement().satisfies(s -> {
            assertThat(s.callId()).isEqualTo("g1-s");
            assertThat(s.softFailure().code()).isEqualTo("322");
        });
        assertThat(all.get("g4").call().swallowedStatements()).isEqualTo(1);
        assertThat(all.get("g5").call().emptyKeys()).containsExactly("searchOffers.offers");
        assertThat(all.get("g3").needsAttention()).isTrue();
        assertThat(all.get("g4").needsAttention()).isFalse();
    }

    @Test
    void theThresholdReRanksWithoutAnotherWrite() {
        service.callObserved(inbound("r", 307, "", "2026-10-05T16:03:37Z"));
        service.callObserved(inbound("p", 200, "{}", "2026-10-05T16:03:37Z"));
        service.callObserved(supplier("p-s", "p", 404, ""));

        assertThat(entry("r").priority()).isEqualTo(3);
        assertThat(entry("p").priority()).isEqualTo(4);
        Map<String, TriageEntry> at400 = service.forCalls(List.of("r", "p"), 400);
        assertThat(at400.get("r").priority()).isEqualTo(6);
        assertThat(at400.get("p").priority()).isEqualTo(4);
        assertThat(service.forCalls(List.of("p"), 500).get("p").priority()).isEqualTo(6);
        assertThat(service.forCalls(List.of("r"), 100).get("r").priority()).as("clamped up to 300").isEqualTo(3);
    }

    @Test
    void arrivalOrderDoesNotMatter() {
        // in order: call, supplier call, statements
        service.callObserved(inbound("a", 200, "{}", "2026-10-05T16:03:35Z"));
        service.callObserved(supplier("a-s", "a", 503, ""));
        service.statementFailures("a", 2, 1);
        // reversed: statements, supplier call, call
        service.statementFailures("b", 2, 1);
        service.callObserved(supplier("b-s", "b", 503, ""));
        assertThat(repo.find("b").orElseThrow().state()).isEqualTo(CallAttention.UNKNOWN);
        service.callObserved(inbound("b", 200, "{}", "2026-10-05T16:03:35Z"));

        CallAttention a = repo.find("a").orElseThrow();
        CallAttention b = repo.find("b").orElseThrow();
        assertThat(b.failingChildren()).isEqualTo(a.failingChildren()).isEqualTo(1);
        assertThat(b.failedStatements()).isEqualTo(a.failedStatements()).isEqualTo(2);
        assertThat(b.swallowedStatements()).isEqualTo(1);
        assertThat(b.priority()).isEqualTo(a.priority()).isEqualTo(4);
        assertThat(b.project()).isEqualTo("odeysys");
        assertThat(b.state()).isEqualTo("COMPLETED");
    }

    @Test
    void aSupplierCallCompletingLateReRanksItsParent() {
        service.callObserved(inbound("p", 500, "{}", "2026-10-05T16:03:35Z"));
        service.callObserved(new ObservedCall("s", CallDirection.OUTBOUND, null, "p", "POST", "https://supplier/s", null, null,
                "2026-10-05T16:08:00Z", null, "IN_PROGRESS", null)); // running for 2 minutes: not hung yet
        assertThat(repo.find("p").orElseThrow().priority()).isEqualTo(3);
        service.callObserved(supplier("s", "p", 502, ""));
        assertThat(repo.find("p").orElseThrow().priority()).isEqualTo(1);
        assertThat(notified.get(notified.size() - 1)).containsExactly("s", "p");
    }

    @Test
    void aLatePreparedNeverUndoesACompletion() {
        service.callObserved(inbound("c", 500, "{}", "2026-10-05T16:03:35Z"));
        service.callObserved(new ObservedCall("c", CallDirection.INBOUND, "odeysys", null, "POST", "/c", null, null,
                "2026-10-05T16:03:35Z", null, "IN_PROGRESS", null));
        assertThat(repo.find("c").orElseThrow().status()).isEqualTo(500);
    }

    @Test
    void aCallStillRunningLongAfterItStartedNeedsAttention() {
        service.callObserved(new ObservedCall("h", CallDirection.INBOUND, "odeysys", null, "GET", "/h", null, null,
                "2026-10-05T16:00:00Z", null, "IN_PROGRESS", null));
        assertThat(entry("h").priority()).isEqualTo(3);
        assertThat(service.live("odeysys", Instant.parse("2026-10-05T15:00:00Z"), null, 5, null, 50))
                .extracting(e -> e.call().callId()).containsExactly("h");
    }

    @Test
    void liveAndCounts() {
        service.callObserved(inbound("x", 500, "{}", "2026-10-05T16:05:00Z"));
        service.callObserved(inbound("y", 200, "{}", "2026-10-05T16:06:00Z"));
        service.callObserved(supplier("y-s", "y", 503, ""));

        assertThat(service.live("odeysys", null, null, 5, null, 50)).extracting(e -> e.call().callId()).containsExactly("y", "x");
        assertThat(service.live("odeysys", null, null, 5, null, 50).get(0).failingSupplierCalls()).extracting(CallAttention::callId)
                .containsExactly("y-s");
        assertThat(service.live("odeysys", null, null, 3, null, 50)).extracting(e -> e.call().callId()).containsExactly("x");
        assertThat(service.counts("odeysys", null, null)).containsEntry(3, 1).containsEntry(4, 1).containsEntry(6, 0);
    }

    @Test
    void tooManyIdsIsRefused() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i <= 500; i++) {
            ids.add("c" + i);
        }
        assertThatThrownBy(() -> service.forCalls(ids, null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void theRowCapKeepsWhatACycleHolds() {
        retained = Set.of("c0");
        for (int i = 0; i < TriageService.PRUNE_EVERY; i++) {
            service.callObserved(inbound("c" + i, 200, "{}", Instant.parse("2026-10-05T15:00:00Z").plusSeconds(i).toString()));
        }
        assertThat(repo.size()).isEqualTo(100);
        assertThat(repo.find("c0")).isPresent();
        assertThat(repo.find("c1")).isEmpty();
        assertThat(repo.find("c199")).isPresent();
    }

    @Test
    void backfillMarker() {
        assertThat(service.backfillNeeded()).isTrue();
        service.backfillDone(3);
        assertThat(service.backfillNeeded()).isFalse();
    }

    @Test
    void aNaiveTimestampIsReadAsUtc() {
        service.callObserved(inbound("t", 200, "{}", "2026-10-05T16:03:35.327"));
        assertThat(repo.find("t").orElseThrow().startedAt()).isEqualTo(Instant.parse("2026-10-05T16:03:35.327Z").toEpochMilli());
    }

    @Test
    void logErrorsMakeASuccessfulCallAHiddenFailureWarningsAndFlagsDoNotAndSignalsSurviveLaterWrites() {
        service.signals("early", new com.fathy.alfred.backend.triage.domain.model.CallSignals(1, 0, 1, "CAUGHT", "ERROR", List.of()));
        service.callObserved(inbound("early", 200, "{}", "2026-10-05T16:03:40Z")); // signals arrived first: kept
        service.callObserved(inbound("warned", 200, "{}", "2026-10-05T16:03:41Z"));
        service.signals("warned", new com.fathy.alfred.backend.triage.domain.model.CallSignals(0, 3, 0, "CAUGHT", "WARN", List.of("REPEATED_QUERY")));
        service.callObserved(inbound("failed", 500, "{}", "2026-10-05T16:03:42Z"));
        service.signals("failed", new com.fathy.alfred.backend.triage.domain.model.CallSignals(2, 0, 0, "CAUGHT", "ERROR", List.of()));

        assertThat(entry("early").priority()).isEqualTo(4);
        assertThat(entry("early").call().signals().logErrors()).isEqualTo(1);
        assertThat(entry("warned").priority()).isEqualTo(6);
        assertThat(entry("warned").call().signals().dbFlags()).containsExactly("REPEATED_QUERY");
        assertThat(entry("failed").priority()).isEqualTo(3); // already failing: its group is unchanged, counted once
        assertThat(com.fathy.alfred.backend.triage.domain.model.Signal.of(entry("failed").call(), 400)).containsExactly(
                com.fathy.alfred.backend.triage.domain.model.Signal.HTTP_ERROR, com.fathy.alfred.backend.triage.domain.model.Signal.LOG_ERROR);
    }

    @Test
    void aDeletedCallTakesItsMarkAndNoOther() {
        service.callObserved(inbound("gone", 500, "{}", "2026-10-05T16:03:35Z"));
        service.callObserved(inbound("kept", 500, "{}", "2026-10-05T16:03:36Z"));

        service.callsDeleted(List.of("gone"));

        assertThat(repo.find("gone")).isEmpty();
        assertThat(repo.find("kept")).isPresent();
    }
}
