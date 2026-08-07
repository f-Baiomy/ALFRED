package com.alfred.pennyworth.application.port.in;

import com.alfred.pennyworth.domain.model.CallRecord;
import com.alfred.pennyworth.domain.model.ExportMetadata;

public interface ExtractExportMetadataUseCase {

    ExportMetadata extract(CallRecord call);
}
