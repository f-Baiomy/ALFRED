package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.CallLogsPage;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.LogCounts;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Match;
import com.fathy.alfred.backend.calllogsbridge.CallLogsModels.Setup;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class CallLogsControllerTest {

    private final CallLogsService service = mock(CallLogsService.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new CallLogsController(service)).build();

    @Test
    void linesOfACall() throws Exception {
        when(service.lines(eq("c1"), eq("cy"), isNull(), eq(50)))
                .thenReturn(Optional.of(new CallLogsPage("c1", Setup.OK, Match.THREAD_TIME, "t-1", 200, List.of(), null)));

        mvc.perform(get("/call-logs/c1").param("cycleId", "cy").param("limit", "50"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.setup").value("OK"))
                .andExpect(jsonPath("$.thread").value("t-1"));
    }

    @Test
    void unknownCallIs404() throws Exception {
        when(service.lines(anyString(), any(), any(), anyInt())).thenReturn(Optional.empty());

        mvc.perform(get("/call-logs/nope")).andExpect(status().isNotFound());
    }

    @Test
    void importKeepsTheLinesAndRejectsAMissingCallId() throws Exception {
        when(service.importLines(eq("imp-1"), any())).thenReturn(1);
        String line = "{\"sourceId\":\"s\",\"sourceName\":\"n\",\"lineId\":\"x:1\",\"at\":\"2026-10-06T10:00:00Z\",\"offsetMs\":0,\"level\":\"INFO\","
                + "\"thread\":null,\"logger\":null,\"message\":\"m\",\"matchedBy\":\"EXACT\",\"kept\":false,\"raw\":\"{}\"}";

        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/call-logs/import")
                        .contentType("application/json").content("{\"callId\":\"imp-1\",\"lines\":[" + line + "]}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.kept").value(1));
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/call-logs/import")
                        .contentType("application/json").content("{\"callId\":\"\",\"lines\":[]}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aLineWithNoCallIs204() throws Exception {
        when(service.forLine("s1", "in:1")).thenReturn(Optional.empty());
        when(service.forLine("s1", "in:2")).thenReturn(Optional.of(new CallLogsModels.LineCall(
                new CallLogsModels.CallRef("c1", "POST", "/x", 200, 12.5, "odeysys", "2026-10-06T10:00:00Z"), Match.EXACT)));

        mvc.perform(get("/call-logs/for-line").param("sourceId", "s1").param("lineId", "in:1")).andExpect(status().isNoContent());
        mvc.perform(get("/call-logs/for-line").param("sourceId", "s1").param("lineId", "in:2"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.call.id").value("c1")).andExpect(jsonPath("$.matchedBy").value("EXACT"));
    }

    @Test
    void countsSplitIdsAndCapAtOneHundred() throws Exception {
        when(service.counts(List.of("a", "b"), null)).thenReturn(Map.of("a", new LogCounts(3, 1, 0, Match.EXACT)));

        mvc.perform(get("/call-logs/counts").param("callIds", "a, b,,a"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.a.lines").value(3))
                .andExpect(jsonPath("$.a.matchedBy").value("EXACT"));

        String many = IntStream.range(0, 101).mapToObj(i -> "c" + i).collect(Collectors.joining(","));
        mvc.perform(get("/call-logs/counts").param("callIds", many)).andExpect(status().isBadRequest());
        verify(service, never()).counts(List.of(), null);
        when(service.counts(List.of("c"), "cy1")).thenReturn(Map.of("c", new LogCounts(1, 0, 0, Match.EXACT)));
        mvc.perform(get("/call-logs/counts").param("callIds", "c").param("cycleId", "cy1")).andExpect(jsonPath("$.c.lines").value(1));
    }
}
