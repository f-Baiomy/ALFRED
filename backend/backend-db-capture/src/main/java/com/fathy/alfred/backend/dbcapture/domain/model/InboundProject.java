package com.fathy.alfred.backend.dbcapture.domain.model;

/** A project the reverse proxy fronts, and whether its inbound logging is on (read from backend-internal-calls by backend-app). */
public record InboundProject(String name, boolean inboundLogging) {
}
