package com.fathy.alfred.backend.resend.application.port.out;

/**
 * Answers whether a call id exists in either call slice (outbound or inbound) - backend-resend
 * is a leaf slice and reads calls only through this out-port; backend-app's resendbridge
 * implements it against backend-calls/backend-internalcalls, the only place allowed to know
 * both slices exist.
 */
public interface CallExistsPort {
    boolean exists(String callId);
}
