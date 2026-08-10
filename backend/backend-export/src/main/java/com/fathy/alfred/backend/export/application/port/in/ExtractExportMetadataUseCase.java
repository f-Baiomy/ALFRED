package com.fathy.alfred.backend.export.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.export.domain.model.ExportMetadata;

public interface ExtractExportMetadataUseCase {

    ExportMetadata extract(CallRecord call);
}
