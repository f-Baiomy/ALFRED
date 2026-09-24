package com.fathy.alfred.backend.resend.domain.model;

/**
 * What {@code useCurrentSession} actually substituted - the header/cookie name and which call its
 * value came from, never the value itself (data-model: "sessionValuesUsed never carries a value").
 */
public record SessionValueUse(String name, String fromCallId) {
}
