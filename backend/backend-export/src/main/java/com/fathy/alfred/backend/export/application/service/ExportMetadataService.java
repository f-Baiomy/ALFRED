package com.fathy.alfred.backend.export.application.service;

import com.fathy.alfred.backend.export.application.port.in.ExtractExportMetadataUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.export.domain.model.ExportMetadata;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * Extracts export metadata (supplier name, credentials selector, API key) from a logged call's
 * request body/headers, so the frontend's export-as-Markdown dialog can pre-fill those fields
 * without parsing call internals itself. Pure logic, no I/O.
 */
@Service
public class ExportMetadataService implements ExtractExportMetadataUseCase {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public ExportMetadata extract(CallRecord call) {
        JsonNode bodyJson = parseBody(call.request());

        return new ExportMetadata(
                CallSummary.supplierNameOf(call),
                textOrNull(bodyJson, "credentialsSelector"),
                findHeaderIgnoreCase(call.request(), "x-api-key"),
                call.url()
        );
    }

    private JsonNode parseBody(RequestData request) {
        if (request == null || request.body() == null || request.body().isBlank()) {
            return null;
        }
        try {
            return objectMapper.readTree(request.body());
        } catch (Exception e) {
            // request body isn't JSON (or isn't an object) - leave metadata null,
            // the frontend form just shows those fields empty and editable.
            return null;
        }
    }

    private String textOrNull(JsonNode node, String field) {
        if (node == null) {
            return null;
        }
        JsonNode value = node.get(field);
        return (value == null || value.isNull()) ? null : value.asText();
    }

    private String findHeaderIgnoreCase(RequestData request, String headerName) {
        if (request == null || request.headers() == null) {
            return null;
        }
        for (Map.Entry<String, String> entry : request.headers().entrySet()) {
            if (entry.getKey().equalsIgnoreCase(headerName)) {
                return entry.getValue();
            }
        }
        return null;
    }
}
