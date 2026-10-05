package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallDbSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetCallStatementsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.GetStatementUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallDbSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(DbCaptureController.class)
class DbCaptureControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockBean
    private GetCallDbSummariesUseCase summaries;
    @MockBean
    private GetCallStatementsUseCase statements;
    @MockBean
    private GetStatementUseCase statement;
    @MockBean
    private DeleteCallStatementsUseCase delete;
    @MockBean
    private com.fathy.alfred.backend.dbcapture.application.port.in.ExportCallStatementsUseCase export;
    @MockBean
    private com.fathy.alfred.backend.dbcapture.application.port.in.InvestigateCallUseCase investigate;
    @MockBean
    private com.fathy.alfred.backend.dbcapture.application.port.in.FindStatementFailuresUseCase failures;

    @Test
    void failuresAnswerPerCall_andTooManyIdsIs400() throws Exception {
        when(failures.failures(List.of("c1", "c2"))).thenReturn(Map.of("c1", new com.fathy.alfred.backend.dbcapture.domain.model.CallStatementFailures(
                "c1", 1, 1, List.of(new com.fathy.alfred.backend.dbcapture.domain.model.CallStatementFailures.FailedStatement(42, 42,
                com.fathy.alfred.backend.dbcapture.domain.model.StatementKind.CALL, null, "CALL LOG_HIT(?)", "42000", 1305,
                "PROCEDURE does not exist", true, true, 1200, "GenericDAOImpl.executeSQLQuery(GenericDAOImpl.java:927)", List.of())))));
        mvc.perform(get("/db-capture/failures").param("callIds", "c1,c2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.c1.failedCount").value(1))
                .andExpect(jsonPath("$.c1.statements[0].seq").value(42))
                .andExpect(jsonPath("$.c1.statements[0].swallowed").value(true))
                .andExpect(jsonPath("$.c2").doesNotExist());

        when(failures.failures(org.mockito.ArgumentMatchers.anyList())).thenThrow(new IllegalArgumentException("At most 500 call ids per request, got 501"));
        mvc.perform(get("/db-capture/failures").param("callIds", "x")).andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("At most 500 call ids per request, got 501"));
    }

    @Test
    void summariesSplitTheIdListAndAnswerOnlyCapturedCalls() throws Exception {
        when(summaries.summaries(List.of("c1", "c2"))).thenReturn(Map.of("c1",
                new CallDbSummary("c1", 3, 1, 0, 0, 1, 0, 9000, 0, List.of(), 3, true, false)));
        mvc.perform(get("/db-capture/summaries").param("callIds", "c1, c2,"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.c1.statementCount").value(3))
                .andExpect(jsonPath("$.c2").doesNotExist());
    }

    @Test
    void statementsPassThePagingParameters() throws Exception {
        when(statements.statements("c1", 40, 100)).thenReturn(new CallStatementsPage(List.of(), List.of(), List.of(), false));
        mvc.perform(get("/db-capture/calls/c1/statements").param("afterSeq", "40").param("limit", "100"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.hasMore").value(false));
        verify(statements).statements("c1", 40, 100);
    }

    @Test
    void anUnknownStatementOrRowsIs404() throws Exception {
        when(statement.statement(anyLong())).thenReturn(Optional.empty());
        when(statement.rows(anyLong(), anyString(), anyInt(), anyInt())).thenReturn(Optional.empty());
        mvc.perform(get("/db-capture/statements/7")).andExpect(status().isNotFound());
        mvc.perform(get("/db-capture/statements/7/rows")).andExpect(status().isNotFound());
    }

    @Test
    void deletingACallsStatements() throws Exception {
        when(delete.deleteForCalls(eq(List.of("c1")))).thenReturn(4);
        mvc.perform(delete("/db-capture/calls/c1")).andExpect(status().isNoContent());
        mvc.perform(delete("/db-capture/calls/c2")).andExpect(status().isNotFound());
    }
}
