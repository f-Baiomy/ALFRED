package com.fathy.alfred.backend.triage.adapter.in.web;

import com.fathy.alfred.backend.triage.application.port.in.QueryAttentionUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallAttention;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.SoftFailure;
import com.fathy.alfred.backend.triage.domain.model.TriageEntry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(TriageController.class)
class TriageControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private QueryAttentionUseCase query;

    private static final CallAttention PARENT = new CallAttention("p1", CallDirection.INBOUND, "odeysys", null, "POST", "/search", 200, null,
            1000, 20035.0, "COMPLETED", null, List.of(), 1, 1, 1, 4);
    private static final CallAttention CHILD = new CallAttention("s1", CallDirection.OUTBOUND, null, "p1", "POST", "https://g94", 200, null,
            1100, 90.0, "COMPLETED", new SoftFailure("xml-error", "322", "No availability"), List.of(), 0, 0, 0, 5);

    @Test
    void callsAnswerTheMarkFlat_withItsFailingSupplierCalls() throws Exception {
        when(query.forCalls(List.of("p1", "zz"), 400)).thenReturn(Map.of("p1", new TriageEntry(PARENT, 4, false, List.of(CHILD))));
        mvc.perform(get("/triage/calls").param("callIds", "p1, zz").param("minStatus", "400"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.p1.callId").value("p1"))
                .andExpect(jsonPath("$.p1.priority").value(4))
                .andExpect(jsonPath("$.p1.failedStatements").value(1))
                .andExpect(jsonPath("$.p1.needsAttention").value(false))
                .andExpect(jsonPath("$.p1.failingSupplierCalls[0].softFailure.code").value("322"))
                .andExpect(jsonPath("$.zz").doesNotExist())
                // Only the ranked priority is sent - the stored one would be a second "priority" key in the same object.
                .andExpect(result -> org.assertj.core.api.Assertions.assertThat(result.getResponse().getContentAsString().split("\"priority\"", -1))
                        .hasSize(2));
    }

    @Test
    void tooManyIdsIs400() throws Exception {
        when(query.forCalls(anyList(), isNull())).thenThrow(new IllegalArgumentException("At most 500 call ids per request, got 501"));
        mvc.perform(get("/triage/calls").param("callIds", "a")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("At most 500 call ids per request, got 501"));
    }

    @Test
    void livePassesTheWindow_andABadInstantIs400() throws Exception {
        when(query.live(eq("odeysys"), eq(Instant.parse("2026-10-05T15:00:00Z")), isNull(), eq(5), isNull(), eq(200)))
                .thenReturn(List.of(new TriageEntry(PARENT, 4, false, List.of(CHILD))));
        mvc.perform(get("/triage/live").param("project", "odeysys").param("since", "2026-10-05T15:00:00Z"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].callId").value("p1"));
        mvc.perform(get("/triage/live").param("since", "yesterday")).andExpect(status().isBadRequest());
    }

    @Test
    void counts() throws Exception {
        when(query.counts(isNull(), isNull(), isNull())).thenReturn(Map.of(1, 0, 3, 2));
        mvc.perform(get("/triage/counts")).andExpect(status().isOk()).andExpect(jsonPath("$.3").value(2));
        verify(query).counts(null, null, null);
    }
}
