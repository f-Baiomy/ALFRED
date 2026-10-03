package com.fathy.alfred.backend.logs.domain.model;

/** What a field means for display (and, later, for turning lines into calls). Each role is on at most one field. */
public enum Role {
    TIME, LEVEL, CORRELATION, MESSAGE, SERVICE, DURATION, STATUS, REQUEST_BODY, RESPONSE_BODY, ERROR
}
