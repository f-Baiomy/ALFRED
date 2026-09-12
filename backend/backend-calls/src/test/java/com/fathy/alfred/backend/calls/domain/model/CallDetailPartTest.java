package com.fathy.alfred.backend.calls.domain.model;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * GET /calls/{id}/detail's {@code part} projection - what a client gets when it expanded one block
 * and has no use for the other three. See CallDetail.part.
 */
class CallDetailPartTest {

    private static final CallDetail FULL = new CallDetail(
            new RequestData(Map.of("accept", "application/json"), "{\"req\":1}"),
            new ResponseData(200, Map.of("content-type", "application/json"), "{\"res\":2}")
    );

    @Test
    void requestHeadersPartCarriesOnlyThoseHeaders() {
        CallDetail part = FULL.part("request-headers");

        assertThat(part.request().headers()).containsEntry("accept", "application/json");
        assertThat(part.request().body()).isNull();
        assertThat(part.response()).isNull();
    }

    @Test
    void requestBodyPartCarriesOnlyThatBody() {
        CallDetail part = FULL.part("request-body");

        assertThat(part.request().body()).isEqualTo("{\"req\":1}");
        assertThat(part.request().headers()).isNull();
        assertThat(part.response()).isNull();
    }

    @Test
    void responsePartsKeepTheStatusButDropTheOtherHalf() {
        CallDetail headers = FULL.part("response-headers");
        assertThat(headers.response().status()).isEqualTo(200);
        assertThat(headers.response().headers()).containsEntry("content-type", "application/json");
        assertThat(headers.response().body()).isNull();
        assertThat(headers.request()).isNull();

        CallDetail body = FULL.part("response-body");
        // The status rides along on both response parts - it costs nothing and it's what tells a
        // caller the response half exists at all.
        assertThat(body.response().status()).isEqualTo(200);
        assertThat(body.response().body()).isEqualTo("{\"res\":2}");
        assertThat(body.response().headers()).isNull();
        assertThat(body.request()).isNull();
    }

    @Test
    void noPartOrAnUnknownOneReturnsTheWholeDetail() {
        // A caller that doesn't know about this parameter - the export path, say - must keep getting
        // everything, and a typo must degrade to that rather than to an error or an empty payload.
        assertThat(FULL.part(null)).isEqualTo(FULL);
        assertThat(FULL.part("")).isEqualTo(FULL);
        assertThat(FULL.part("response-bodyy")).isEqualTo(FULL);
    }

    @Test
    void aPartOfAHalfThatWasNeverRecordedIsNullRatherThanAFailure() {
        CallDetail requestOnly = new CallDetail(new RequestData(Map.of(), ""), null);

        assertThat(requestOnly.part("response-body").response()).isNull();
        assertThat(requestOnly.part("response-headers").response()).isNull();
    }
}
