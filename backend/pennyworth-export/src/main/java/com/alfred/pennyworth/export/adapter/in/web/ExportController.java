package com.alfred.pennyworth.export.adapter.in.web;

import com.alfred.pennyworth.export.application.port.in.ExtractExportMetadataUseCase;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.export.domain.model.ExportMetadata;
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
