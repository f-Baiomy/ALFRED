package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Where a call in the breakpoint inspector physically is.
 *
 * <p>This exists because "paused" was being asked to mean two completely different things. A call
 * that is <em>holding</em> has a real client socket open and somebody waiting on the other end of
 * it; a call that has been released and is on its way upstream, or has finished entirely, holds
 * nobody at all. Both are on screen - following a call through its whole cycle is the point - but
 * only the first is urgent, and only the first belongs in the count that shouts at you from the
 * tab bar. One number covering all three would have the badge crying wolf about calls nobody is
 * waiting on, which teaches you to ignore it.
 *
 * <p>The wire form is lower-case with hyphens, matching {@code phase} and {@code onTimeout}, which
 * are plain strings on the same record.
 */
public enum PauseStage {

    /** A caller's connection is open and waiting on a decision. The only stage with a countdown. */
    HOLDING("holding"),

    /** Released and forwarded; the supplier is working. Nobody is held, nothing is expiring. */
    IN_FLIGHT("in-flight"),

    /** The cycle is over. Kept on screen only because somebody asked to follow it, and closed by hand. */
    FINISHED("finished");

    private final String wire;

    PauseStage(String wire) {
        this.wire = wire;
    }

    @JsonValue
    public String wire() {
        return wire;
    }

    @JsonCreator
    public static PauseStage fromWire(String value) {
        if (value == null) {
            // A proxy that predates this field, or a register call that simply does not care -
            // registering is always the start of a hold.
            return HOLDING;
        }
        for (PauseStage stage : values()) {
            if (stage.wire.equalsIgnoreCase(value) || stage.name().equalsIgnoreCase(value)) {
                return stage;
            }
        }
        return HOLDING;
    }

    public boolean holdsCaller() {
        return this == HOLDING;
    }
}
