package com.fathy.alfred.backend.internalcalls.application.port.out;

import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;

/**
 * Whether an arriving inbound call is stored at all - the storage page's "Stop recording" endpoints, implemented in
 * backend-app so this slice never names it. Missing bean = every call is recorded. Forwarding is never affected.
 */
public interface InternalCallFilterPort {

    boolean isRecorded(CallRecord call);

    /** A call that was not stored: whatever its agent still sends for it must not stay behind. */
    default void notRecorded(String callId) {
    }
}
