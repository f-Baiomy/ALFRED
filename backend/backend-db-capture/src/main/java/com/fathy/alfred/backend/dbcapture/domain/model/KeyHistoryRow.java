package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/** One read or write of a key by a recorded call - "Every call that used this key" and Claude's redis_key_history. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record KeyHistoryRow(String callId, int seq, String op, String command, String at, String outcome, String method, String path,
                            Integer status, Boolean sameValueAsPrevious) {
}
