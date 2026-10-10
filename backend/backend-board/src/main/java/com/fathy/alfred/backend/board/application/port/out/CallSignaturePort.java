package com.fathy.alfred.backend.board.application.port.out;

import java.util.Optional;

/**
 * {@code <signal>|<METHOD> <endpoint pattern>} of a call, e.g. {@code 5xx|POST /api/orders/{n}} - implemented in
 * backend-app/boardbridge with the call lookup and triage's endpoint normalizer (research R12). Empty when the call is
 * unknown. {@code cycleId} is set for a call captured in a cycle.
 */
public interface CallSignaturePort {

    Optional<String> signatureOf(String direction, String callId, String cycleId);
}
