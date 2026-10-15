package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/016 SAME_RESPONSE: the JSON paths a re-test reads from a response body. */
class BoardCallFactsAdapterTest {

    @Test
    void readsFieldsIndexesAndLengths() throws Exception {
        var root = new ObjectMapper().readTree("{\"countries\":[{\"code\":\"AE\"},{\"code\":\"EG\"}],\"total\":2,\"name\":\"abc\"}");
        assertThat(BoardCallFactsAdapter.value(root, "$.countries.length")).isEqualTo("2");
        assertThat(BoardCallFactsAdapter.value(root, "$.countries[1].code")).isEqualTo("EG");
        assertThat(BoardCallFactsAdapter.value(root, "$.total")).isEqualTo("2");
        assertThat(BoardCallFactsAdapter.value(root, "$.name.length")).isEqualTo("3");
        assertThat(BoardCallFactsAdapter.value(root, "$.length")).isEqualTo("3");
        assertThat(BoardCallFactsAdapter.value(root, "$.missing")).isNull();
        assertThat(BoardCallFactsAdapter.value(root, "$.countries[9]")).isNull();
        assertThat(BoardCallFactsAdapter.value(root, "countries")).isNull();
    }

    @Test
    void theRequirementCheckReadsACapturedCallsBodiesAndNothingOfAnUnansweredOne() {
        var cycle = org.mockito.Mockito.mock(com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase.class);
        var live = org.mockito.Mockito.mock(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase.class);
        var detail = new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(
                new com.fathy.alfred.backend.internalcalls.domain.model.RequestData(java.util.Map.of(), "{\"branchId\":948}"),
                new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(200, java.util.Map.of(), "{\"payload\":[]}"), null);
        org.mockito.Mockito.when(cycle.getDetail("c-1", "a")).thenReturn(java.util.Optional.of(detail));
        org.mockito.Mockito.when(cycle.getDetail("c-1", "b")).thenReturn(java.util.Optional.of(
                new com.fathy.alfred.backend.internalcalls.domain.model.CallDetail(detail.request(), null, null)));
        org.mockito.Mockito.when(cycle.getDetail("c-1", "gone")).thenReturn(java.util.Optional.empty());
        var adapter = new BoardCallFactsAdapter(live, cycle, null, null, null, null);

        assertThat(adapter.bodies("a", "c-1")).hasValueSatisfying(b -> {
            assertThat(b.status()).isEqualTo(200);
            assertThat(b.requestBody()).isEqualTo("{\"branchId\":948}");
            assertThat(b.responseBody()).isEqualTo("{\"payload\":[]}");
        });
        assertThat(adapter.bodies("b", "c-1")).isEmpty();
        assertThat(adapter.bodies("gone", "c-1")).isEmpty();
    }
}
