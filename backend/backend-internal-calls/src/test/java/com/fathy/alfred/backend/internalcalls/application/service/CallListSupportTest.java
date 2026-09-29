package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.RequestData;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

class CallListSupportTest {

    @Test
    void searchMatchesInsideALargeBodyAndIgnoresAMiss() {
        CallRecord call = new CallRecord("id", "http://app/search", "http://app/search", "POST",
                new RequestData(null, "xx".repeat(20_000) + "NeedleToken" + "yy".repeat(20_000)),
                "t", 1.0, new ResponseData(200, null, "ok"), null);
        var hit = CallListSupport.apply(List.of(call), Function.identity(), "needletoken", "", "newest", 0, 10, true);
        var miss = CallListSupport.apply(List.of(call), Function.identity(), "not-in-this-call", "", "newest", 0, 10, true);
        assertThat(hit.total()).isEqualTo(1);
        assertThat(miss.total()).isEqualTo(0);
    }
}
