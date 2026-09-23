package com.fathy.alfred.backend.resend.domain.model;

/** Reported to the user: which header came from which call. No value. */
public record SessionValueUse(String name, String fromCallId) {
}
