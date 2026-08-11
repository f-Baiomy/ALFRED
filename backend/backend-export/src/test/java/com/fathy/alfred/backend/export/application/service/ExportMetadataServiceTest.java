package com.fathy.alfred.backend.export.application.service;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.export.domain.model.ExportMetadata;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ExportMetadataServiceTest {

    private final ExportMetadataService service = new ExportMetadataService();

    private static CallRecord callWith(RequestData request, String url) {
        return new CallRecord("id-" + url, url, url, "POST", request, "t", 1.0, null, null);
    }

    @Test
    void extractsSupplierAndCredentialsFromTheJsonBody() {
        RequestData request = new RequestData(Map.of(), "{\"supplier\":\"FlyNas\",\"credentialsSelector\":\"EGY\"}");
        ExportMetadata metadata = service.extract(callWith(request, "https://example.com/api/x"));

        assertThat(metadata.supplierName()).isEqualTo("FlyNas");
        assertThat(metadata.credentialsUsed()).isEqualTo("EGY");
        assertThat(metadata.url()).isEqualTo("https://example.com/api/x");
    }

    @Test
    void findsTheApiKeyHeaderCaseInsensitively() {
        RequestData request = new RequestData(Map.of("X-Api-Key", "secret-123"), null);
        ExportMetadata metadata = service.extract(callWith(request, "https://example.com/api/x"));

        assertThat(metadata.apiKey()).isEqualTo("secret-123");
    }

    @Test
    void returnsNullFieldsWhenTheBodyIsNotJson() {
        RequestData request = new RequestData(Map.of(), "not json at all");
        ExportMetadata metadata = service.extract(callWith(request, "https://example.com/api/x"));

        assertThat(metadata.supplierName()).isNull();
        assertThat(metadata.credentialsUsed()).isNull();
    }

    @Test
    void returnsNullFieldsWhenThereIsNoRequest() {
        ExportMetadata metadata = service.extract(callWith(null, "https://example.com/api/x"));

        assertThat(metadata.supplierName()).isNull();
        assertThat(metadata.apiKey()).isNull();
        assertThat(metadata.url()).isEqualTo("https://example.com/api/x");
    }
}
