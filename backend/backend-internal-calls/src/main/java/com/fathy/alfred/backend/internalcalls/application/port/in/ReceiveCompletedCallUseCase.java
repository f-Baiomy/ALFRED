package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.ResponseData;

/** Inbound port for the reverse proxy's second webhook call - a previously-prepared call's outcome has arrived. */
public interface ReceiveCompletedCallUseCase {

    /**
     * @param response WildFly's actual reply, or null if it never came ({@code error} set instead).
     * @return true if a call with this id was prepared and is now updated; false if not (the
     * caller - the webhook controller - should respond 404).
     */
    boolean receiveCompletedCall(String id, ResponseData response, String error, Double durationMs);
}
