package com.alfred.pennyworth.calls.application.port.in;

import com.alfred.pennyworth.calls.domain.model.CallRecord;

/** Inbound port for the proxy's real-time webhook - a new call just finished. */
public interface ReceiveNewCallUseCase {

    void receiveNewCall(CallRecord call);
}
