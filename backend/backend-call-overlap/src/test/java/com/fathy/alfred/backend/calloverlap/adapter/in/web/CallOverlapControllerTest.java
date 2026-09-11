package com.fathy.alfred.backend.calloverlap.adapter.in.web;

import com.fathy.alfred.backend.calloverlap.application.port.in.GetCallOverlapsUseCase;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapEntry;
import com.fathy.alfred.backend.calloverlap.domain.model.CallOverlapQuery;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(CallOverlapController.class)
class CallOverlapControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private GetCallOverlapsUseCase getCallOverlapsUseCase;

    @Test
    void returnsTheUseCasesMergedListAsJson() throws Exception {
        CallOverlapEntry external = new CallOverlapEntry("call-1", "external", null, "2024-01-01T00:00:00Z", 12.5, 200, null);
        CallOverlapEntry internal = new CallOverlapEntry("call-2", "internal", "wildfly", "2024-01-01T00:00:01Z", 5.0, 500, "boom");
        when(getCallOverlapsUseCase.getOverlaps(any())).thenReturn(List.of(external, internal));

        mockMvc.perform(get("/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("call-1"))
                .andExpect(jsonPath("$[0].source").value("external"))
                .andExpect(jsonPath("$[1].id").value("call-2"))
                .andExpect(jsonPath("$[1].source").value("internal"))
                .andExpect(jsonPath("$[1].serviceName").value("wildfly"));
    }

    @Test
    void parsesTheRequiredFromAndToParamsAndDefaultsEveryOtherFilterToBlank() throws Exception {
        when(getCallOverlapsUseCase.getOverlaps(any())).thenReturn(List.of());

        mockMvc.perform(get("/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isOk());

        verify(getCallOverlapsUseCase).getOverlaps(new CallOverlapQuery(
                Instant.parse("2024-01-01T00:00:00Z"), Instant.parse("2024-01-01T00:00:05Z"),
                "", "", "", "", "", ""));
    }

    @Test
    void acceptsAnOffsetDateTimeShapedTimestampAsAFallback() throws Exception {
        when(getCallOverlapsUseCase.getOverlaps(any())).thenReturn(List.of());

        mockMvc.perform(get("/call-overlaps")
                        .param("from", "2024-01-01T00:00:00+00:00")
                        .param("to", "2024-01-01T00:00:05+00:00"))
                .andExpect(status().isOk());

        verify(getCallOverlapsUseCase).getOverlaps(eq(new CallOverlapQuery(
                Instant.parse("2024-01-01T00:00:00Z"), Instant.parse("2024-01-01T00:00:05Z"),
                "", "", "", "", "", "")));
    }

    @Test
    void passesEveryOptionalFilterThroughWhenProvided() throws Exception {
        when(getCallOverlapsUseCase.getOverlaps(any())).thenReturn(List.of());

        mockMvc.perform(get("/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "2024-01-01T00:00:05Z")
                        .param("search", "boom")
                        .param("supplier", "example.com")
                        .param("serviceNames", "svc-a,svc-b")
                        .param("sessionId", "sess-1")
                        .param("operationId", "op-1")
                        .param("requestId", "req-1"))
                .andExpect(status().isOk());

        verify(getCallOverlapsUseCase).getOverlaps(new CallOverlapQuery(
                Instant.parse("2024-01-01T00:00:00Z"), Instant.parse("2024-01-01T00:00:05Z"),
                "boom", "example.com", "svc-a,svc-b", "sess-1", "op-1", "req-1"));
    }

    @Test
    void rejectsAnUnparseableFromTimestampWithBadRequest() throws Exception {
        mockMvc.perform(get("/call-overlaps")
                        .param("from", "not-a-timestamp")
                        .param("to", "2024-01-01T00:00:05Z"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsAnUnparseableToTimestampWithBadRequest() throws Exception {
        mockMvc.perform(get("/call-overlaps")
                        .param("from", "2024-01-01T00:00:00Z")
                        .param("to", "not-a-timestamp"))
                .andExpect(status().isBadRequest());
    }
}
