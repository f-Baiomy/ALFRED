package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.application.port.in.AnnotateLogsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogInputsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Thin web tests: validation, size limits and how use-case failures map to HTTP statuses. */
@WebMvcTest({LogSourcesController.class, LogInputsController.class, LogQueryController.class, LogAnnotationsController.class,
        LogsWebErrors.class})
class LogsControllersTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private ManageLogSourcesUseCase sources;
    @MockBean
    private ManageLogInputsUseCase inputs;
    @MockBean
    private QueryLogsUseCase query;
    @MockBean
    private AnnotateLogsUseCase annotate;

    @Test
    void duplicateFileIs409AndUnknownSourceIs404() throws Exception {
        when(inputs.add(eq("s1"), any(), anyString(), any(), anyBoolean(), eq(false)))
                .thenThrow(new LogsException(LogsException.Kind.CONFLICT, "DUPLICATE_FILE"));
        mvc.perform(post("/logs/sources/s1/inputs").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"SERVER_FILE\",\"ref\":\"detail.log\"}"))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.error").value("DUPLICATE_FILE"));

        when(query.lines(eq("nope"), any())).thenThrow(LogsException.notFound("Log source"));
        mvc.perform(post("/logs/sources/nope/lines").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void invalidBodiesAre400() throws Exception {
        mvc.perform(post("/logs/sources/s1/inputs").contentType(MediaType.APPLICATION_JSON).content("{\"kind\":\"SERVER_FILE\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/logs/sources/s1/lines/l1/comments").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"" + "x".repeat(4001) + "\"}"))
                .andExpect(status().isBadRequest());
        when(query.lines(eq("s1"), any())).thenThrow(LogsException.bad("message is text - set its type to number"));
        mvc.perform(post("/logs/sources/s1/lines").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error").value("message is text - set its type to number"));
    }

    @Test
    void oversizedChunkIsRefusedBeforeReadingIt() throws Exception {
        mvc.perform(put("/logs/uploads/u0123456789abcdef/chunks/0").contentType(MediaType.APPLICATION_OCTET_STREAM)
                        .content(new byte[(int) LogInputsController.MAX_CHUNK + 1]))
                .andExpect(status().isPayloadTooLarge());
    }

    @Test
    void linesReturnsThePage() throws Exception {
        when(query.lines(eq("s1"), any())).thenReturn(new LogPage(List.of(), 0, null, 3, false));
        mvc.perform(post("/logs/sources/s1/lines").contentType(MediaType.APPLICATION_JSON).content("{\"limit\":100000}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.total").value(0));
    }
}
