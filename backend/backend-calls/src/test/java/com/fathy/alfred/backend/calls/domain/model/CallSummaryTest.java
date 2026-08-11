package com.fathy.alfred.backend.calls.domain.model;

import org.junit.jupiter.api.Test;

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
}
