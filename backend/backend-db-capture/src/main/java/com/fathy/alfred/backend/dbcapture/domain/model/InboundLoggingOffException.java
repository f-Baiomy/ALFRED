package com.fathy.alfred.backend.dbcapture.domain.model;

/** Capture cannot be switched on for a project whose inbound logging is off (409). */
public class InboundLoggingOffException extends RuntimeException {
    public InboundLoggingOffException(String project) {
        super("Inbound logging is off for " + project + " - turn it on first: statements are attached to inbound calls");
    }
}
