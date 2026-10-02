package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CheckEvaluationServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void passesAWellFormedRequestToTheEvaluator() throws Exception {
        JsonNode answer = mapper.readTree("{\"groups\":[]}");
        CheckEvaluationService service = new CheckEvaluationService(request -> answer);
        assertThat(service.evaluate(mapper.readTree("{\"groups\":[],\"answer\":{}}"))).isSameAs(answer);
    }

    @Test
    void rejectsARequestWithoutGroupsOrAnswer() throws Exception {
        CheckEvaluationService service = new CheckEvaluationService(request -> request);
        assertThatThrownBy(() -> service.evaluate(mapper.readTree("{\"answer\":{}}"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> service.evaluate(mapper.readTree("{\"groups\":[]}"))).isInstanceOf(IllegalArgumentException.class);
    }
}
