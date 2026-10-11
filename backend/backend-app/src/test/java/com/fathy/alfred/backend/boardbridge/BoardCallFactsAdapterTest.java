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
}
