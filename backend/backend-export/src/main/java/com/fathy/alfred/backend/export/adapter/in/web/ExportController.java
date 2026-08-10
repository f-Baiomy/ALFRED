package com.fathy.alfred.backend.export.adapter.in.web;

import com.fathy.alfred.backend.export.application.port.in.ExtractExportMetadataUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.export.domain.model.ExportMetadata;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ExportController {

    private final ExtractExportMetadataUseCase extractExportMetadataUseCase;

    public ExportController(ExtractExportMetadataUseCase extractExportMetadataUseCase) {
        this.extractExportMetadataUseCase = extractExportMetadataUseCase;
    }

    @PostMapping("/calls/export-metadata")
    public ExportMetadata exportMetadata(@RequestBody CallRecord call) {
        return extractExportMetadataUseCase.extract(call);
    }
}
