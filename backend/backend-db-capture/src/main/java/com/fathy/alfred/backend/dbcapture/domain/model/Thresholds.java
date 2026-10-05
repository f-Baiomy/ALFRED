package com.fathy.alfred.backend.dbcapture.domain.model;

/** When the flags fire (FR-023). Defaults are the values the agreed mock shows. */
public record Thresholds(int slowMs, int hugeRows, int repeatCount, int largeDeleteRows) {

    /** slowMs counts only the time BEYOND the call's database round trip (RoundTrip) - 100 ms by default. */
    public static final Thresholds DEFAULTS = new Thresholds(100, 1000, 5, 100);
    /** The default before slow was measured beyond the round trip - a stored 20 is read as the new default. */
    public static final int LEGACY_SLOW_MS = 20;

    public Thresholds {
        if (slowMs == LEGACY_SLOW_MS) {
            slowMs = DEFAULTS_SLOW_MS;
        }
    }

    private static final int DEFAULTS_SLOW_MS = 100;
}
