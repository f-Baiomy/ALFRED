package com.fathy.alfred.backend.dbcapture.domain.model;

/** When the flags fire (FR-023). Defaults are the values the agreed mock shows. */
public record Thresholds(int slowMs, int hugeRows, int repeatCount, int largeDeleteRows) {

    public static final Thresholds DEFAULTS = new Thresholds(20, 1000, 5, 100);
}
