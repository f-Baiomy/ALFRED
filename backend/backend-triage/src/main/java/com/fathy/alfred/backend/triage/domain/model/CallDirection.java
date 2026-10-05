package com.fathy.alfred.backend.triage.domain.model;

/** INBOUND = a call into a project the reverse proxy fronts; OUTBOUND = a supplier call the forward proxy logged. */
public enum CallDirection {
    INBOUND, OUTBOUND
}
