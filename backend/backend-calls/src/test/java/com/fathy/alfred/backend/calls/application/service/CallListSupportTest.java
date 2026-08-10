package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

class CallListSupportTest {

    private static CallRecord call(String url, String timestamp, Double durationMs, Integer status, String error) {
        return new CallRecord(url, url, "GET", new RequestData(null, null), timestamp, durationMs,
                status == null ? null : new ResponseData(status, null, null), error);
    }

    @Test
    void oldestIsTheSourceOrderUnchanged() {
        List<CallRecord> source = List.of(call("a", "t", 1.0, 200, null), call("b", "t", 1.0, 200, null));
        var page = CallListSupport.apply(source, Function.identity(), "", "", "oldest", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("a", "b");
    }

    @Test
    void newestReversesTheSourceOrder() {
        List<CallRecord> source = List.of(call("a", "t", 1.0, 200, null), call("b", "t", 1.0, 200, null));
        var page = CallListSupport.apply(source, Function.identity(), "", "", "newest", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("b", "a");
    }

    @Test
    void sortsByParsedTimestamp() {
        List<CallRecord> source = List.of(
                call("late", "2026-01-02T00:00:00Z", 1.0, 200, null),
                call("early", "2026-01-01T00:00:00Z", 1.0, 200, null),
                call("unparseable", "not-a-date", 1.0, 200, null)
        );
        var oldest = CallListSupport.apply(source, Function.identity(), "", "", "oldest-call", 0, 10);
        assertThat(oldest.items()).extracting(CallRecord::url).containsExactly("unparseable", "early", "late");

        var newest = CallListSupport.apply(source, Function.identity(), "", "", "newest-call", 0, 10);
        assertThat(newest.items()).extracting(CallRecord::url).containsExactly("late", "early", "unparseable");
    }

    @Test
    void acceptsThePythonProxysOffsetTimestampFormat() {
        List<CallRecord> source = List.of(
                call("later", "2026-01-02T00:00:00.123456+00:00", 1.0, 200, null),
                call("earlier", "2026-01-01T00:00:00.123456+00:00", 1.0, 200, null)
        );
        var page = CallListSupport.apply(source, Function.identity(), "", "", "oldest-call", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("earlier", "later");
    }

    @Test
    void sortsByDuration() {
        List<CallRecord> source = List.of(call("slow", "t", 500.0, 200, null), call("fast", "t", 10.0, 200, null));
        var slowest = CallListSupport.apply(source, Function.identity(), "", "", "slowest", 0, 10);
        assertThat(slowest.items()).extracting(CallRecord::url).containsExactly("slow", "fast");

        var fastest = CallListSupport.apply(source, Function.identity(), "", "", "fastest", 0, 10);
        assertThat(fastest.items()).extracting(CallRecord::url).containsExactly("fast", "slow");
    }

    @Test
    void sortsByStatusWithErrorsRankedWorst() {
        List<CallRecord> source = List.of(
                call("ok", "t", 1.0, 200, null),
                call("errored", "t", 1.0, null, "boom"),
                call("serverError", "t", 1.0, 500, null)
        );
        var page = CallListSupport.apply(source, Function.identity(), "", "", "status", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("errored", "serverError", "ok");
    }

    @Test
    void searchMatchesUrlCaseInsensitively() {
        List<CallRecord> source = List.of(call("https://Api.Example.com/x", "t", 1.0, 200, null), call("https://other.com/y", "t", 1.0, 200, null));
        var page = CallListSupport.apply(source, Function.identity(), "api.example", "", "newest", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("https://Api.Example.com/x");
    }

    @Test
    void filtersBySupplierHostname() {
        List<CallRecord> source = List.of(call("https://a.com/x", "t", 1.0, 200, null), call("https://b.com/y", "t", 1.0, 200, null));
        var page = CallListSupport.apply(source, Function.identity(), "", "a.com", "newest", 0, 10);
        assertThat(page.items()).extracting(CallRecord::url).containsExactly("https://a.com/x");
    }

    @Test
    void paginatesWithOffsetAndReportsTotalBeforePaging() {
        List<CallRecord> source = List.of(
                call("a", "t", 1.0, 200, null), call("b", "t", 1.0, 200, null),
                call("c", "t", 1.0, 200, null), call("d", "t", 1.0, 200, null)
        );
        var page1 = CallListSupport.apply(source, Function.identity(), "", "", "oldest", 0, 2);
        assertThat(page1.items()).extracting(CallRecord::url).containsExactly("a", "b");
        assertThat(page1.total()).isEqualTo(4);

        var page2 = CallListSupport.apply(source, Function.identity(), "", "", "oldest", 2, 2);
        assertThat(page2.items()).extracting(CallRecord::url).containsExactly("c", "d");
    }

    @Test
    void offsetPastTheEndReturnsAnEmptyPageNotAnError() {
        List<CallRecord> source = List.of(call("a", "t", 1.0, 200, null));
        var page = CallListSupport.apply(source, Function.identity(), "", "", "oldest", 50, 10);
        assertThat(page.items()).isEmpty();
        assertThat(page.total()).isEqualTo(1);
    }
}
