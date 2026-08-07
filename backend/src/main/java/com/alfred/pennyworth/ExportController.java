package com.alfred.pennyworth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Extracts export metadata (supplier name, credentials selector, API key)
 * from a logged call's request body/headers, so the frontend's
 * export-as-Markdown dialog can pre-fill those fields without parsing call
 * internals itself.
 */
@RestController
public class ExportController {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @PostMapping("/calls/export-metadata")
    public ExportMetadataDto exportMetadata(@RequestBody CallRecordDto call) {
        JsonNode bodyJson = parseBody(call.request());

        return new ExportMetadataDto(
                textOrNull(bodyJson, "supplier"),
                textOrNull(bodyJson, "credentialsSelector"),
                findHeaderIgnoreCase(call.request(), "x-api-key"),
                call.url()
        );
    }

    private JsonNode parseBody(RequestDataDto request) {
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

    private String findHeaderIgnoreCase(RequestDataDto request, String headerName) {
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
