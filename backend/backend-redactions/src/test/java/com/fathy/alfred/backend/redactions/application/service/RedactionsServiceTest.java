package com.fathy.alfred.backend.redactions.application.service;

import com.fathy.alfred.backend.redactions.application.port.out.RedactionsStorePort;
import com.fathy.alfred.backend.redactions.domain.model.NewRedaction;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import com.fathy.alfred.backend.redactions.domain.model.RedactionScope;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RedactionsServiceTest {

    private static Redaction callScoped(String id, String callId) {
        return new Redaction(id, RedactionScope.CALL, callId, RedactionKind.REQUEST_HEADER, "authorization", "2026-01-01T00:00:00Z");
    }

    private static Redaction allScoped(String id) {
        return new Redaction(id, RedactionScope.ALL, null, RedactionKind.RESPONSE_HEADER, "set-cookie", "2026-01-01T00:00:00Z");
    }

    @Test
    void assignsIdAndTimestampOnCreate() {
        RedactionsStorePort store = mock(RedactionsStorePort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        RedactionsService service = new RedactionsService(store);

        Redaction created = service.create(
                new NewRedaction(RedactionScope.CALL, "call-1", RedactionKind.RESPONSE_BODY_KEY, "data.accessToken"));

        assertThat(created.id()).isNotBlank();
        assertThat(created.createdAt()).isNotBlank();
        assertThat(created.scope()).isEqualTo(RedactionScope.CALL);
        assertThat(created.callId()).isEqualTo("call-1");
        assertThat(created.kind()).isEqualTo(RedactionKind.RESPONSE_BODY_KEY);
        assertThat(created.name()).isEqualTo("data.accessToken");

        ArgumentCaptor<Redaction> captor = ArgumentCaptor.forClass(Redaction.class);
        verify(store).save(captor.capture());
        assertThat(captor.getValue()).isEqualTo(created);
    }

    @Test
    void dropsAnyCallIdOnAnAllScopedRedaction() {
        RedactionsStorePort store = mock(RedactionsStorePort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        RedactionsService service = new RedactionsService(store);

        Redaction created = service.create(
                new NewRedaction(RedactionScope.ALL, "call-1", RedactionKind.URL_PARAM, "api_key"));

        assertThat(created.callId()).isNull();
    }

    @Test
    void listAllReturnsEverything() {
        RedactionsStorePort store = mock(RedactionsStorePort.class);
        when(store.findAll()).thenReturn(List.of(callScoped("r1", "call-a"), allScoped("r2")));
        RedactionsService service = new RedactionsService(store);

        assertThat(service.listAll()).extracting(Redaction::id).containsExactly("r1", "r2");
    }

    @Test
    void listForCallIdReturnsThatCallsRedactionsPlusEveryAllScopedOne() {
        RedactionsStorePort store = mock(RedactionsStorePort.class);
        when(store.findAll()).thenReturn(List.of(
                callScoped("r1", "call-a"),
                callScoped("r2", "call-b"),
                allScoped("r3")));
        RedactionsService service = new RedactionsService(store);

        List<Redaction> result = service.listForCallId("call-a");

        assertThat(result).extracting(Redaction::id).containsExactly("r1", "r3");
    }

    @Test
    void delegatesDeleteToTheStore() {
        RedactionsStorePort store = mock(RedactionsStorePort.class);
        when(store.deleteById(eq("r1"))).thenReturn(true);
        RedactionsService service = new RedactionsService(store);

        assertThat(service.deleteById("r1")).isTrue();
        assertThat(service.deleteById("missing")).isFalse();
    }
}
