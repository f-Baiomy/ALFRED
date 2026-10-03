package com.fathy.alfred.backend.logs.domain.ingest;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Payload option A: which parts of a line are kept as one field (the detail.log request/response bodies). */
class PayloadRuleTest {

    @Test
    void aPartWithManyFieldsIsOnePayloadAndItsSiblingsStayFields() {
        List<String> paths = new ArrayList<>(List.of("timestamp", "message.context.externalService", "message.context.timeTaken",
                "message.context.PccID", "message.methodName"));
        for (int i = 0; i < 60; i++) {
            paths.add("message.context.response.bean.option.f" + i);
        }
        assertThat(PayloadRule.choose(paths, List.of())).containsExactly("message.context.response.bean.option");
    }

    @Test
    void keysThatAreDataMakeTheirParentAPayload() {
        assertThat(PayloadRule.choose(List.of("message.context.returnValue.body.priceClasses.R2FsaWxlbyNFR1kjd1lXNVZk.fareType",
                "message.context.request.passengersList.0.name.first", "message.methodName"), List.of()))
                .containsExactlyInAnyOrder("message.context.returnValue.body.priceClasses", "message.context.request.passengersList");
        assertThat(PayloadRule.idLike("R2FsaWxlbyNFR1kjazdvUnp1U3FXREtBNUVtNEFBQUFBQT09")).isTrue();
        assertThat(PayloadRule.idLike("addPaxToBookingResponseBean")).isFalse();
        assertThat(PayloadRule.idLike("externalService")).isFalse();
    }

    @Test
    void aPartHoldingARoleFieldIsNeverAPayload() {
        List<String> paths = new ArrayList<>(List.of("message.context.externalService", "message.context.timeTaken"));
        for (int i = 0; i < 60; i++) {
            paths.add("message.context.dto" + i + ".name");
        }
        assertThat(PayloadRule.choose(paths, List.of(), List.of("message.context.timeTaken"))).isEmpty();
        assertThat(PayloadRule.choose(paths, List.of())).containsExactly("message.context");
    }

    @Test
    void ordinaryLinesHaveNoPayloadAndKnownPayloadsAreNotChosenAgain() {
        assertThat(PayloadRule.choose(List.of("a.b", "a.c", "message.text"), List.of())).isEmpty();
        assertThat(PayloadRule.choose(List.of("x.y.0.z"), List.of("x.y"))).isEmpty();
        assertThat(PayloadRule.collapse(List.of("x.y.0.z", "x.y.1.z", "x.k"), List.of("x.y"))).containsExactly("x.y", "x.k");
    }
}
