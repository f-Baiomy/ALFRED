package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.SessionValue;

import java.util.List;
import java.util.Set;

/**
 * The newest value of each named request header on LIVE calls to the same host, newest first,
 * skipping {@code excludeCallId}. "Current session" means current: a session cycle's captured
 * calls are older than the live log by construction, so they are not searched.
 */
public interface SessionValueLookupPort {
    List<SessionValue> newest(String direction, String authority, Set<String> headerNames, String excludeCallId);
}
