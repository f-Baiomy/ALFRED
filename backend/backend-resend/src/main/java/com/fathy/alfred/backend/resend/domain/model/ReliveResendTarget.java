package com.fathy.alfred.backend.resend.domain.model;

/** Set when this resend IS a Relive run sending an inbound step (research D2) - ResendService
 *  then adds X-Alfred-Relive/X-Operation-Id so the proxy's relive.attribute() can find it. */
public record ReliveResendTarget(String runId, String stepKey) {
}
