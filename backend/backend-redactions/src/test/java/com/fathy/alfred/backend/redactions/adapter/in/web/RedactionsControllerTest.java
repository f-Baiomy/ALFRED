package com.fathy.alfred.backend.redactions.adapter.in.web;

import com.fathy.alfred.backend.redactions.application.port.in.CreateRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.DeleteRedactionUseCase;
import com.fathy.alfred.backend.redactions.application.port.in.ListRedactionsUseCase;
import com.fathy.alfred.backend.redactions.domain.model.NewRedaction;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(RedactionsController.class)
class RedactionsControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ListRedactionsUseCase listRedactionsUseCase;
    @MockBean
    private CreateRedactionUseCase createRedactionUseCase;
    @MockBean
    private DeleteRedactionUseCase deleteRedactionUseCase;

    @Test
    void listsEverythingWhenNoCallIdIsGiven() throws Exception {
        when(listRedactionsUseCase.listAll()).thenReturn(List.of(
                new Redaction("r1", RedactionScope.ALL, null, RedactionKind.REQUEST_HEADER, "authorization", "t")));

        mockMvc.perform(get("/redactions"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value("r1"))
                .andExpect(jsonPath("$[0].name").value("authorization"));

        verify(listRedactionsUseCase).listAll();
    }

    @Test
    void listsForOneCallWhenCallIdIsGiven() throws Exception {
        when(listRedactionsUseCase.listForCallId(eq("call-1"))).thenReturn(List.of());

        mockMvc.perform(get("/redactions").param("callId", "call-1"))
                .andExpect(status().isOk());

        verify(listRedactionsUseCase).listForCallId("call-1");
    }

    @Test
    void acceptsAValidCallScopedRedactionAndDelegatesToTheUseCase() throws Exception {
        Redaction created = new Redaction("r1", RedactionScope.CALL, "call-1", RedactionKind.REQUEST_HEADER, "authorization", "2026-01-01T00:00:00Z");
        when(createRedactionUseCase.create(any())).thenReturn(created);

        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"CALL","callId":"call-1","kind":"REQUEST_HEADER","name":"authorization"}
                                """))
                .andExpect(status().isOk());

        verify(createRedactionUseCase).create(
                new NewRedaction(RedactionScope.CALL, "call-1", RedactionKind.REQUEST_HEADER, "authorization"));
    }

    /**
     * The contract the Angular client actually speaks. It sends kebab-case ('call', 'request-header')
     * to match Comment.block's existing wire values, so a mismatch here is not a cosmetic naming
     * argument - every attempt to hide anything 400s, and the user is told nothing was redacted only
     * after they have shared the file.
     */
    @Test
    void acceptsTheKebabCaseWireValuesTheFrontendSends() throws Exception {
        Redaction created = new Redaction("r1", RedactionScope.CALL, "call-1", RedactionKind.RESPONSE_BODY_KEY, "access_token", "2026-01-01T00:00:00Z");
        when(createRedactionUseCase.create(any())).thenReturn(created);

        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"call","callId":"call-1","kind":"response-body-key","name":"access_token"}
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.scope").value("call"))
                .andExpect(jsonPath("$.kind").value("response-body-key"));

        verify(createRedactionUseCase).create(
                new NewRedaction(RedactionScope.CALL, "call-1", RedactionKind.RESPONSE_BODY_KEY, "access_token"));
    }

    @Test
    void acceptsAnAllScopedRedactionWithNoCallId() throws Exception {
        Redaction created = new Redaction("r1", RedactionScope.ALL, null, RedactionKind.RESPONSE_HEADER, "set-cookie", "2026-01-01T00:00:00Z");
        when(createRedactionUseCase.create(any())).thenReturn(created);

        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"ALL","kind":"RESPONSE_HEADER","name":"set-cookie"}
                                """))
                .andExpect(status().isOk());

        verify(createRedactionUseCase).create(
                new NewRedaction(RedactionScope.ALL, null, RedactionKind.RESPONSE_HEADER, "set-cookie"));
    }

    @Test
    void rejectsACallScopedRedactionWithoutACallId() throws Exception {
        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"CALL","callId":"","kind":"REQUEST_HEADER","name":"authorization"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsAnAllScopedRedactionThatCarriesACallId() throws Exception {
        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"ALL","callId":"call-1","kind":"REQUEST_HEADER","name":"authorization"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsARedactionWithABlankName() throws Exception {
        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"CALL","callId":"call-1","kind":"URL_PARAM","name":"  "}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsARedactionWithNoKind() throws Exception {
        mockMvc.perform(post("/redactions")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"scope":"CALL","callId":"call-1","name":"authorization"}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void returnsNotFoundWhenDeletingAMissingRedaction() throws Exception {
        when(deleteRedactionUseCase.deleteById(eq("missing"))).thenReturn(false);

        mockMvc.perform(delete("/redactions/missing"))
                .andExpect(status().isNotFound());
    }

    @Test
    void returnsNoContentWhenDeletingAnExistingRedaction() throws Exception {
        when(deleteRedactionUseCase.deleteById(eq("r1"))).thenReturn(true);

        mockMvc.perform(delete("/redactions/r1"))
                .andExpect(status().isNoContent());
    }
}
