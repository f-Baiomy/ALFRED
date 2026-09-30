package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class StepJsonTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void aCycleSavedBeforeFingerprintsExistStillLoads() throws Exception {
        String json = """
                {
                  "key": "c-1",
                  "parentKey": "s-1",
                  "label": "supplier",
                  "enabled": true,
                  "optional": false,
                  "direction": "outbound",
                  "serviceName": "svc",
                  "callRule": { "rule": {} },
                  "unattributed": "BLOCK",
                  "recording": {
                    "method": "GET",
                    "url": "https://api.supplier.com/search",
                    "requestHeaders": {},
                    "requestBody": "",
                    "status": 200,
                    "responseHeaders": {},
                    "responseBody": "",
                    "timestamp": "t",
                    "durationMs": 1,
                    "source": "outbound"
                  },
                  "source": null,
                  "extract": [],
                  "assertions": [],
                  "noise": []
                }
                """;
        Step step = objectMapper.readValue(json, Step.class);
        assertThat(step.key()).isEqualTo("c-1");
        assertThat(step.recording().url()).isEqualTo("https://api.supplier.com/search");
        assertThat(step.fingerprint()).isNull();
        assertThat(step.fingerprintVersion()).isNull();
    }

    @Test
    void fingerprintRoundTrips() throws Exception {
        Step step = objectMapper.readValue("""
                {"key":"c-1","label":"supplier","enabled":true,"optional":false,"direction":"outbound",
                 "unattributed":"BLOCK","extract":[],"assertions":[],"noise":[],
                 "fingerprint":"abc","fingerprintVersion":"SEMANTIC_V1"}
                """, Step.class);
        Step again = objectMapper.readValue(objectMapper.writeValueAsString(step), Step.class);
        assertThat(again.fingerprint()).isEqualTo("abc");
        assertThat(again.fingerprintVersion()).isEqualTo("SEMANTIC_V1");
    }
}
