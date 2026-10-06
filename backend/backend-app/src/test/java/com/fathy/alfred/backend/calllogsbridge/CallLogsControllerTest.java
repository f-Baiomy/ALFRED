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
    void countsSplitIdsAndCapAtOneHundred() throws Exception {
        when(service.counts(List.of("a", "b"))).thenReturn(Map.of("a", new LogCounts(3, 1, 0, Match.EXACT)));

        mvc.perform(get("/call-logs/counts").param("callIds", "a, b,,a"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.a.lines").value(3))
                .andExpect(jsonPath("$.a.matchedBy").value("EXACT"));

        String many = IntStream.range(0, 101).mapToObj(i -> "c" + i).collect(Collectors.joining(","));
        mvc.perform(get("/call-logs/counts").param("callIds", many)).andExpect(status().isBadRequest());
        verify(service, never()).counts(List.of());
    }
}
