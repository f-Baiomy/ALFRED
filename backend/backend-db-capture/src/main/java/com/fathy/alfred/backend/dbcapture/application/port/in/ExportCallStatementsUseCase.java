package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallDbCaptureExport;

import java.util.Map;
import java.util.Optional;

/** A call's statements with every stored row, for exports; and the inverse, re-importing them from a .json export. */
public interface ExportCallStatementsUseCase {

    /** Empty when the call was not captured. */
    Optional<CallDbCaptureExport> export(String callId);

    /** Stores the captures of an imported file, by call id. Idempotent: importing the same file twice adds nothing. Returns statements stored. */
    int importCaptures(Map<String, CallDbCaptureExport> byCallId);
}
