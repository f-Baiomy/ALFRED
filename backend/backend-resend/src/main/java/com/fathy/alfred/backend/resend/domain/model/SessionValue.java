package com.fathy.alfred.backend.resend.domain.model;

/** A candidate replacement value found by {@code SessionValueLookupPort.newest} - the value itself never leaves this package. */
public record SessionValue(String name, String value, String fromCallId) {
}
