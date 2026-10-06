package com.fathy.alfred.backend.triage.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.triage.adapter.out.sqlite.SqliteAttentionRepository;
import com.fathy.alfred.backend.triage.domain.EndpointPattern;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.CallSignals;
import com.fathy.alfred.backend.triage.domain.model.EndpointHealth;
import com.fathy.alfred.backend.triage.domain.model.ProblemCall;
import com.fathy.alfred.backend.triage.domain.model.ProblemCallsPage;
import com.fathy.alfred.backend.triage.domain.model.ProblemFilter;
import com.fathy.alfred.backend.triage.domain.model.Signal;
import com.fathy.alfred.backend.triage.domain.model.SignalTimeline;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Problem calls, endpoint health and the timeline over saved marks (specs/010-mcp-log-investigation). */
class TriageAnalysisServiceTest {

    @TempDir
    Path tempDir;

    private SqliteAttentionRepository repo;
    private TriageAnalysisService analysis;
    private static final long T0 = 1_790_000_000_000L;

    @BeforeEach
    void open() throws Exception {
        repo = new SqliteAttentionRepository(new ObjectMapper());
        Field field = SqliteAttentionRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repo, tempDir.resolve("triage.db").toString());
        repo.init();
        analysis = new TriageAnalysisService(repo);
    }

    @AfterEach
    void close() throws InterruptedException {
        repo.close();
        Thread.sleep(50);
    }

    private void call(String id, String url, Integer status, long at, int failed, int failingChildren, CallSignals signals) {
        repo.save(new CallAttention(id, CallDirection.INBOUND, "odeysys", null, "POST", url, status, null, at, 100.0 + at % 1000, "COMPLETED",
                null, List.of(), failingChildren, failed, 0, 6, signals));
    }

    private static CallSignals logs(int errors, int warnings, int exceptions, String... flags) {
        return new CallSignals(errors, warnings, exceptions, "CAUGHT", "WARN", List.of(flags));
    }

    private void seed() {
        call("http500", "http://h/booking/123/confirm", 500, T0, 0, 0, CallSignals.NONE);
        call("swallowed", "http://h/booking/456/confirm", 200, T0 + 1_000, 1, 0, CallSignals.NONE);
        call("nplus1", "http://h/search", 200, T0 + 2_000, 0, 0, logs(0, 0, 0, "REPEATED_QUERY"));
        call("logged", "http://h/search", 200, T0 + 3_000, 0, 0, logs(2, 1, 1));
        call("warned", "http://h/search", 200, T0 + 120_000, 0, 0, logs(0, 3, 0));
        call("clean", "http://h/search", 200, T0 + 121_000, 0, 0, CallSignals.NONE);
        call("supplier", "http://h/pay", 200, T0 + 122_000, 0, 1, CallSignals.NONE);
    }

    private static final List<String> IDS = List.of("http500", "swallowed", "nplus1", "logged", "warned", "clean", "supplier", "not-marked");

    @Test
    void everySignalIsCountedAndEveryProblemCallListedOnceErrorsFirst() {
        seed();
        ProblemCallsPage page = analysis.problemCalls(IDS, ProblemFilter.everything(), 0, 50);

        assertThat(page.total()).isEqualTo(7);
        assertThat(page.counts()).containsEntry(Signal.HTTP_ERROR, 1).containsEntry(Signal.DB_FAILED, 1).containsEntry(Signal.DB_WARNING, 1)
                .containsEntry(Signal.LOG_ERROR, 1).containsEntry(Signal.LOG_EXCEPTION, 1).containsEntry(Signal.LOG_WARNING, 2)
                .containsEntry(Signal.SUPPLIER_FAILED, 1);
        assertThat(page.calls()).extracting(p -> p.call().callId()).doesNotContain("clean").hasSize(6);
        assertThat(page.calls().get(0).call().callId()).isEqualTo("logged"); // an error with the most signals
        assertThat(page.calls().get(0).signals()).containsExactly(Signal.LOG_ERROR, Signal.LOG_EXCEPTION, Signal.LOG_WARNING);
        assertThat(page.calls()).filteredOn(p -> p.severity().equals("warning")).extracting(p -> p.call().callId())
                .containsExactlyInAnyOrder("warned", "nplus1");
    }

    @Test
    void filtersCombineAllAnyAndNoneAndNarrowDbWarningsByFlag() {
        seed();
        ProblemFilter loggedButOk = new ProblemFilter(Set.of(Signal.LOG_ERROR), null, Set.of(Signal.HTTP_ERROR), null, 0, null, null, null);
        assertThat(analysis.problemCalls(IDS, loggedButOk, 0, 50).calls()).extracting(p -> p.call().callId()).containsExactly("logged");

        ProblemFilter dbOnlyWarnings = new ProblemFilter(Set.of(Signal.DB_WARNING), null, Set.of(Signal.LOG_ERROR, Signal.HTTP_ERROR, Signal.DB_FAILED),
                List.of("REPEATED_QUERY"), 0, null, null, null);
        assertThat(analysis.problemCalls(IDS, dbOnlyWarnings, 0, 50).calls()).extracting(p -> p.call().callId()).containsExactly("nplus1");
        ProblemFilter otherFlag = new ProblemFilter(Set.of(Signal.DB_WARNING), null, null, List.of("SLOW"), 0, null, null, null);
        assertThat(analysis.problemCalls(IDS, otherFlag, 0, 50).calls()).isEmpty();

        ProblemFilter anyDb = new ProblemFilter(null, Set.of(Signal.DB_FAILED, Signal.DB_WARNING), null, null, 0, null, T0 + 1_500, null);
        assertThat(analysis.problemCalls(IDS, anyDb, 0, 50).calls()).extracting(p -> p.call().callId()).containsExactly("nplus1");
    }

    @Test
    void pagesThroughManyCallsWithExactCounts() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 5_000; i++) {
            ids.add("c" + i);
            call("c" + i, "http://h/x/" + i, i % 10 == 0 ? 502 : 200, T0 + i, 0, 0, i % 7 == 0 ? logs(1, 0, 0) : CallSignals.NONE);
        }
        long started = System.nanoTime();
        ProblemCallsPage first = analysis.problemCalls(ids, ProblemFilter.everything(), 0, 200);
        assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(5_000);
        assertThat(first.counts().get(Signal.HTTP_ERROR)).isEqualTo(500);
        assertThat(first.matching()).isEqualTo(500 + 715 - 72); // 5xx, plus logged errors, those both counted once
        assertThat(first.calls()).hasSize(200);
        assertThat(first.nextOffset()).isEqualTo(200);
        assertThat(analysis.problemCalls(ids, ProblemFilter.everything(), 1_000, 200).nextOffset()).isNull();
    }

    @Test
    void endpointsGroupIdsInPathsWorstFirstAndTheTimelineShowsWhenProblemsStarted() {
        seed();
        List<EndpointHealth> endpoints = analysis.endpoints(IDS, null, null, null, 10);
        assertThat(endpoints).extracting(EndpointHealth::endpoint).containsExactly("POST /booking/{id}/confirm", "POST /search", "POST /pay");
        EndpointHealth search = endpoints.get(1);
        assertThat(search.calls()).isEqualTo(4);
        assertThat(search.errorCalls()).isEqualTo(1);
        assertThat(search.warningCalls()).isEqualTo(2);
        assertThat(search.logWarnings()).isEqualTo(2);

        SignalTimeline timeline = analysis.timeline(IDS, null, null, null, 1);
        assertThat(timeline.buckets()).hasSize(2);
        assertThat(timeline.firstSeen()).containsEntry(Signal.LOG_ERROR, T0 + 3_000).containsEntry(Signal.SUPPLIER_FAILED, T0 + 122_000);
        assertThat(analysis.timeline(IDS, null, null, null, 0).bucketMinutes()).isEqualTo(1);
    }

    @Test
    void endpointPatternsReplaceOnlyClearValues() {
        assertThat(EndpointPattern.of("post", "http://h:9001/odeysysadmin/Booking2/flight-search/search?x=1"))
                .isEqualTo("POST /odeysysadmin/Booking2/flight-search/search");
        assertThat(EndpointPattern.path("/booking/123")).isEqualTo("/booking/{id}");
        assertThat(EndpointPattern.path("/b/72c31e6a-b77d-4499-95bd-d94cd889cdcb/x")).isEqualTo("/b/{id}/x");
        assertThat(EndpointPattern.path("/order/ORD20391")).isEqualTo("/order/{id}");
        assertThat(EndpointPattern.path("/Admin2/userDetails")).isEqualTo("/Admin2/userDetails");
        assertThat(EndpointPattern.path(null)).isEqualTo("/");
    }

    @Test
    void aProblemCallCarriesItsSignalsInOrder() {
        seed();
        ProblemCall swallowed = analysis.problemCalls(List.of("swallowed"), ProblemFilter.everything(), 0, 5).calls().get(0);
        assertThat(swallowed.signals()).containsExactly(Signal.DB_FAILED);
        assertThat(swallowed.severity()).isEqualTo("error");
    }

    @Test
    void twentyThousandMarksAnswerEachQuestionInUnderASecond() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 20_000; i++) {
            ids.add("s" + i);
            call("s" + i, "http://h/booking/" + i + "/confirm", i % 25 == 0 ? 500 : 200, T0 + i * 100L, i % 40 == 0 ? 1 : 0, 0,
                    i % 9 == 0 ? logs(1, 2, 0, "SLOW") : CallSignals.NONE);
        }
        long started = System.nanoTime();
        ProblemCallsPage page = analysis.problemCalls(ids, ProblemFilter.everything(), 0, 50);
        long problem = (System.nanoTime() - started) / 1_000_000;
        started = System.nanoTime();
        List<EndpointHealth> endpoints = analysis.endpoints(ids, null, null, null, 10);
        long health = (System.nanoTime() - started) / 1_000_000;
        started = System.nanoTime();
        SignalTimeline timeline = analysis.timeline(ids, null, null, null, 1);
        long time = (System.nanoTime() - started) / 1_000_000;

        assertThat(page.total()).isEqualTo(20_000);
        assertThat(endpoints).hasSize(1);
        assertThat(timeline.buckets()).isNotEmpty();
        assertThat(List.of(problem, health, time)).allMatch(ms -> ms < 1_000);
    }
}
