package com.alfred.pennyworth.export.application.port.in;

import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.alfred.pennyworth.export.domain.model.ExportMetadata;

public interface ExtractExportMetadataUseCase {

    ExportMetadata extract(CallRecord call);
}
