package com.fathy.alfred.backend.interception.domain.model;

/**
 * How {@link ActionType#SIMULATE_FAILURE} breaks a call - the network-level things a supplier does
 * that are not a status code, grouped into one action so the editor asks "what goes wrong?" once
 * rather than offering six near-identical actions in a list.
 *
 * <p>The names are the wire format, matched by string in proxy/interception.py's FAILURE_MODES.
 *
 * <p><b>What is deliberately NOT here.</b> The caller is connected to Alfred, not to the supplier,
 * and its TLS handshake with Alfred has already succeeded by the time any rule is evaluated. A
 * DNS failure or a certificate error therefore cannot be shown to it - the connection it would
 * have to fail on is one that already worked. Offering them would be a lie in a dropdown. Every
 * network failure that IS reachable from here arrives at the caller as a reset or a timeout; what
 * genuinely differs is when and how the connection dies, which is what these vary.
 */
public enum FailureMode {

    /** Killed before forwarding. The caller sees a reset/EOF rather than any HTTP response. */
    CONNECTION_RESET,

    /**
     * Accepted, held, then killed - the supplier that goes quiet mid-call. Needs a duration, and
     * it is the interesting one to test: the caller's own read timeout is what finally fires.
     */
    HANG_THEN_DROP,

    /**
     * Held until the caller gives up on its own (up to the engine's pause cap). Distinct from
     * HANG_THEN_DROP in who ends it - here Alfred never does, so what you are testing is whether
     * the client HAS a timeout at all.
     */
    HANG_UNTIL_CALLER_GIVES_UP,

    /** A valid 200 with zero bytes. Parses as HTTP and breaks anything that assumes a body. */
    EMPTY_REPLY,

    /**
     * A body cut short of the Content-Length it declares - the shape of a supplier dropping
     * mid-transfer, which a client library reports very differently from an empty reply.
     */
    TRUNCATED_BODY,

    /**
     * 502/503/504 with a plausible body, without contacting the host - the intermediary failing
     * rather than the supplier. Needs a status.
     */
    GATEWAY_ERROR;

    public static boolean isKnown(String name) {
        for (FailureMode mode : values()) {
            if (mode.name().equals(name)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Whether this mode ends the connection with nothing sent back, rather than a deliberately
     * broken response - the same split proxy/interception.py's failure_plan() makes to decide
     * between {@code kill} and {@code response}. Needed here only so a {@code PauseDecision} can
     * tell BreakpointService which of its two existing outcomes a mode reaches, without
     * duplicating failure_plan's full behaviour on this side - the proxy remains the one place
     * that decides what each mode actually DOES, this only knows which family it falls into.
     */
    public boolean killsConnection() {
        return this == CONNECTION_RESET || this == HANG_THEN_DROP || this == HANG_UNTIL_CALLER_GIVES_UP;
    }
}
