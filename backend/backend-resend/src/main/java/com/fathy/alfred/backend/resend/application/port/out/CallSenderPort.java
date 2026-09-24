package com.fathy.alfred.backend.resend.application.port.out;

/** Actually sends a resend back through Alfred's own proxies. */
public interface CallSenderPort {

    SendOutcome send(OutgoingCall call);
}
