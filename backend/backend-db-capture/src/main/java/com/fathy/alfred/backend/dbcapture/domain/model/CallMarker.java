package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * A non-statement event in a call's sequence. CALL_OPEN (seq 0) is sent the moment the agent starts tracking a
 * call, so a call that ran no statements still has a zero summary ("◆ DB 0", distinct from "not captured").
 * HTTP_OUT is each outbound request the agent tagged with X-Alfred-Parent, at the same seq - so supplier calls'
 * positions are known here without reading another slice. URLs carry no query string.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CallMarker(String callId, int seq, MarkerType type, String at, String method, String url) {
}
