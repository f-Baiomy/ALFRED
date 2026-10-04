package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/** One place a traced value appears in a call: a parameter, a stored row, a before-image row, a generated key or an OUT parameter. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TraceHit(int seq, String where, int index, String column) {
    public static final String PARAM = "PARAM";
    public static final String ROW = "ROW";
    public static final String BEFORE_IMAGE = "BEFORE_IMAGE";
    public static final String KEY = "KEY";
    public static final String OUT = "OUT";
}
