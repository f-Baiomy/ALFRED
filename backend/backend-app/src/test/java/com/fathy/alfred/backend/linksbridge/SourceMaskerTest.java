package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.links.domain.JsonRewriter;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import com.fathy.alfred.backend.redactions.domain.model.RedactionKind;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What a stream sends is masked at the source (D17, D28): the always-masked headers, and whatever the owner's
 * redaction rules name, before a frame leaves - the rest of the answer byte for byte.
 */
class SourceMaskerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String R = SourceMasker.REDACTED;

    private static Redaction rule(RedactionKind kind, String name) {
        return new Redaction("r-" + name, null, null, kind, name, "2026-10-19T08:00:00Z");
    }

    private static JsonNode masked(String json, Redaction... rules) throws Exception {
        return JSON.readTree(JsonRewriter.rewrite(json, new SourceMasker(List.of(rules))));
    }

    @Test
    void theAlwaysMaskedHeadersNeverLeaveWhateverTheirCase() throws Exception {
        JsonNode n = masked("""
                {"requestHeaders":{"Authorization":"Bearer abc","Cookie":"s=1","Accept":"*/*"},
                 "responseHeaders":{"Set-Cookie":["a=1","b=2"],"Content-Type":"application/json"},
                 "headers":{"X-API-Key":"k","x-alfred-call":"id=1; key=secret"}}""");
        assertThat(n.at("/requestHeaders/Authorization").asText()).isEqualTo(R);
        assertThat(n.at("/requestHeaders/Cookie").asText()).isEqualTo(R);
        assertThat(n.at("/requestHeaders/Accept").asText()).isEqualTo("*/*");
        assertThat(n.at("/responseHeaders/Set-Cookie/0").asText()).isEqualTo(R);
        assertThat(n.at("/responseHeaders/Set-Cookie/1").asText()).isEqualTo(R);
        assertThat(n.at("/responseHeaders/Content-Type").asText()).isEqualTo("application/json");
        assertThat(n.at("/headers/X-API-Key").asText()).isEqualTo(R);
        assertThat(n.at("/headers/x-alfred-call").asText()).isEqualTo(R);
    }

    @Test
    void theOwnersRulesMaskHeadersBodyKeysUrlParamsAndColumns() throws Exception {
        JsonNode n = masked("""
                {"url":"http://h/pay?card=4111&amount=5#top","requestHeaders":{"X-Tenant":"acme"},
                 "requestBody":"{\\"user\\":\\"ann\\",\\"password\\":\\"p\\",\\"nested\\":{\\"Password\\":\\"q\\"}}",
                 "responseBody":"<login><password>p</password><user pin=\\"1234\\">ann</user></login>",
                 "statements":[{"sql":"select","params":["x"],"rows":[{"SSN":"123","name":"ann","ssn_num":5}]}]}""",
                rule(RedactionKind.REQUEST_HEADER, "x-tenant"), rule(RedactionKind.REQUEST_BODY_KEY, "password"),
                rule(RedactionKind.RESPONSE_BODY_KEY, "pin"), rule(RedactionKind.URL_PARAM, "card"), rule(RedactionKind.DB_COLUMN, "ssn"));
        assertThat(n.at("/url").asText()).isEqualTo("http://h/pay?card=" + R + "&amount=5#top");
        assertThat(n.at("/requestHeaders/X-Tenant").asText()).isEqualTo(R);
        JsonNode body = JSON.readTree(n.at("/requestBody").asText());
        assertThat(body.at("/user").asText()).isEqualTo("ann");
        assertThat(body.at("/password").asText()).isEqualTo(R);
        assertThat(body.at("/nested/Password").asText()).isEqualTo(R);
        String xml = n.at("/responseBody").asText();
        assertThat(xml).contains("<password>" + R + "</password>").contains("pin=\"" + R + "\"").contains(">ann</user>");
        assertThat(n.at("/statements/0/rows/0/SSN").asText()).isEqualTo(R);
        assertThat(n.at("/statements/0/rows/0/name").asText()).isEqualTo("ann");
        assertThat(n.at("/statements/0/rows/0/ssn_num").asInt()).isEqualTo(5);
        // a bound value cannot be tied to its column: with a column rule, every one is masked (more, never less)
        assertThat(n.at("/statements/0/params/0").asText()).isEqualTo(R);
    }

    @Test
    void withoutRulesTheAnswerIsUntouchedApartFromTheAlwaysMaskedHeaders() throws Exception {
        String body = "{\"responseBody\":\"{\\\"password\\\":\\\"p\\\"}\",\"url\":\"http://h/?card=1\",\"rows\":[{\"ssn\":\"1\"}]}";
        assertThat(JsonRewriter.rewrite(body, new SourceMasker(List.of()))).isEqualTo(body);
    }

    @Test
    void aFormBodyIsMaskedPairByPair() {
        SourceMasker m = new SourceMasker(List.of(rule(RedactionKind.REQUEST_BODY_KEY, "password")));
        assertThat(m.body("user=ann&password=p&x=")).isEqualTo("user=ann&password=" + R + "&x=");
        assertThat(m.body("plain text password=p")).isEqualTo("plain text password=p");
    }
}
