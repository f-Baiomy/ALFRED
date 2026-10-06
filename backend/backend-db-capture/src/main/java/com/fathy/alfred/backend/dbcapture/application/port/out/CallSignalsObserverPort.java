package com.fathy.alfred.backend.dbcapture.application.port.out;

import java.util.List;

/**
 * Told whenever a call's log or database signals may have changed (specs/010-mcp-log-investigation): after a batch
 * that brought its log lines or statements, when the call completes (its flags are final then), when it is imported,
 * and when its project's thresholds change. Implemented in backend-app, where triage keeps them on its indexed mark
 * per call; this slice knows nothing of who listens - the same shape as {@link StatementFailuresObserverPort}.
 *
 * @param logStatus CAUGHT when the agent caught (or an import brought) this call's lines, else null (unknown here)
 * @param logLevel  the Log level the agent applied to this call, null when it did not say
 * @param dbFlags   names of the database flags raised for the call (failures excluded - they are counted apart)
 */
public interface CallSignalsObserverPort {

    void signalsChanged(String callId, int logErrors, int logWarnings, int logExceptions, String logStatus, String logLevel, List<String> dbFlags);
}
