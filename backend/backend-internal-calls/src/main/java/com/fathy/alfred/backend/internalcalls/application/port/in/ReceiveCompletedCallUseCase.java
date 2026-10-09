package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.CallInterception;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;

/** Inbound port for the reverse proxy's second webhook call - a previously-prepared call's outcome has arrived. */
public interface ReceiveCompletedCallUseCase {

    /**
     * @param response WildFly's actual reply, or null if it never came ({@code error} set instead).
     * @return true if a call with this id was prepared and is now updated; false if not (the
     * caller - the webhook controller - should respond 404).
     */
    default boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs) {
        return receiveCompletedCall(id, response, error, durationMs, null, null);
    }

    /** @param interception what an interception rule did to the call, or null when none touched it. */
    default boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs,
                                         CallInterception interception) {
        return receiveCompletedCall(id, response, error, durationMs, interception, null);
    }

    /** @param reachedUpstream whether this call actually reached a real external system - see CallLogPort.complete. */
    boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs,
                                 CallInterception interception, Boolean reachedUpstream);

    /** @param known the call as the proxy saw it (no headers or body) - see CallLogPort.complete. */
    default boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs,
                                         CallInterception interception, Boolean reachedUpstream, CallRecord known) {
        return receiveCompletedCall(id, response, error, durationMs, interception, reachedUpstream);
    }
}
