package com.fathy.alfred.backend.resend.domain.model;

/** A session header value found on a newer call - the value never leaves the backend. */
public record SessionValue(String name, String value, String fromCallId) {
}
