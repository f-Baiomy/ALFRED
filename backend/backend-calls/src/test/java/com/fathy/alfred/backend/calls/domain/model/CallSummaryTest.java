package com.fathy.alfred.backend.calls.domain.model;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CallSummaryTest {

    private static CallRecord callWith(RequestData request) {
        return new CallRecord("id-1", "https://x.com-proxy/api", "https://x.com/api", "POST", request, "t", 1.0, null, null);
    }

    @Test
    void extractsTheSupplierFieldFromTheRequestBodysJson() {
        RequestData request = new RequestData(Map.of(), "{\"supplier\":\"FlyNas\"}");
        assertThat(CallSummary.supplierNameOf(callWith(request))).isEqualTo("FlyNas");
    }

    @Test
    void isNullWhenTheBodyIsNotJson() {
        RequestData request = new RequestData(Map.of(), "not json at all");
        assertThat(CallSummary.supplierNameOf(callWith(request))).isNull();
    }

    @Test
    void isNullWhenTheBodyHasNoSupplierField() {
        RequestData request = new RequestData(Map.of(), "{\"other\":\"value\"}");
        assertThat(CallSummary.supplierNameOf(callWith(request))).isNull();
    }

    @Test
    void isNullWhenThereIsNoRequest() {
        assertThat(CallSummary.supplierNameOf(callWith(null))).isNull();
    }

    @Test
    void ofCarriesTheSupplierNameThroughAlongsideTheOtherSummaryFields() {
        RequestData request = new RequestData(Map.of(), "{\"supplier\":\"FlyNas\"}");
        CallSummary summary = CallSummary.of(callWith(request));

        assertThat(summary.supplierName()).isEqualTo("FlyNas");
        assertThat(summary.id()).isEqualTo("id-1");
    }

    @Test
    void listSummaryKeepsTheInterceptionBadgeAndDropsSnapshotBodies() {
        String body = "SECRET-BODY";
        CallInterception.Http original = new CallInterception.Http(null, null, "POST", "https://x.com/api", Map.of("a", "b"), body);
        CallInterception stored = new CallInterception(
                List.of(new CallInterception.Applied("r", "rule", "REPLACE_BODY", null)),
                original, null, null, null);
        CallRecord call = new CallRecord("id-1", "https://x.com-proxy/api", "https://x.com/api", "POST",
                new RequestData(Map.of(), "{}"), "t", 1.0, null, null, CallLifecycleStatus.COMPLETED,
                null, null, null, null, stored, null, null);

        CallSummary summary = CallSummary.of(call);

        assertThat(summary.interception().applied()).hasSize(1);
        assertThat(summary.interception().originalRequest().url()).isEqualTo("https://x.com/api");
        assertThat(summary.interception().originalRequest().headers()).containsEntry("a", "b");
        assertThat(summary.interception().originalRequest().body()).isNull();
        assertThat(stored.originalRequest().body()).isEqualTo(body);
    }
}
