package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.OutgoingCall;
import com.fathy.alfred.backend.resend.domain.model.SendOutcome;

public interface CallSenderPort {
    SendOutcome send(OutgoingCall call);
}
