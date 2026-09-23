package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Bridges backend-resend's SessionValueLookupPort to each call slice's own
 * FindRecentRequestHeadersUseCase - same reasoning as CallSourceAdapter: backend-resend must not
 * depend on either call slice directly.
 */
@Component
public class SessionValueLookupAdapter implements SessionValueLookupPort {

    private final com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound;

    public SessionValueLookupAdapter(com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound,
                                      com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound) {
        this.outbound = outbound;
        this.inbound = inbound;
    }

    @Override
    public List<SessionValue> newest(String direction, String authority, Set<String> headerNames, String excludeCallId) {
        Set<String> wanted = new TreeSet<>(String.CASE_INSENSITIVE_ORDER);
        wanted.addAll(headerNames);
        List<SessionValue> found = new ArrayList<>();

        if ("outbound".equals(direction)) {
            for (var row : outbound.findRecent(authority, 200)) {
                if (wanted.isEmpty()) {
                    break;
                }
                if (row.callId().equals(excludeCallId)) {
                    continue;
                }
                collect(row.callId(), row.headers(), wanted, found);
            }
        } else if ("inbound".equals(direction)) {
            for (var row : inbound.findRecent(authority, 200)) {
                if (wanted.isEmpty()) {
                    break;
                }
                if (row.callId().equals(excludeCallId)) {
                    continue;
                }
                collect(row.callId(), row.headers(), wanted, found);
            }
        }
        return found;
    }

    private static void collect(String callId, Map<String, String> headers, Set<String> wanted, List<SessionValue> found) {
        if (headers == null) {
            return;
        }
        List<String> matchedThisRow = new ArrayList<>();
        for (String name : wanted) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (entry.getKey().equalsIgnoreCase(name)) {
                    found.add(new SessionValue(name.toLowerCase(), entry.getValue(), callId));
                    matchedThisRow.add(name);
                    break;
                }
            }
        }
        wanted.removeAll(matchedThisRow);
    }
}
