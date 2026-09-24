package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Bridges backend-resend's SessionValueLookupPort - what {@code useCurrentSession} scans for the
 * newest cookie/authorization value seen for a host. A live call goes through the two
 * FindRecentRequestHeadersUseCase in-ports (T108), already newest-first and cheap (no bodies). A
 * cycle-scoped resend has no such index, so it scans the cycle's own captured-call list, newest
 * first, fetching each candidate's headers only until every name in {@code names} is found -
 * usually the very first or second call, since a session value changes rarely within one cycle.
 */
@Component
public class SessionValueLookupAdapter implements SessionValueLookupPort {

    /** How far into a cycle's captured calls to look before giving up on a name - a session-cycle recording is a bounded, human-sized thing, unlike the main call log. */
    private static final int MAX_CYCLE_SCAN = 200;

    private final com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound;
    private final ListCapturedCallsUseCase capturedOutboundList;
    private final com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase capturedOutboundDetail;
    private final ListCapturedInternalCallsUseCase capturedInboundList;
    private final com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase capturedInboundDetail;

    public SessionValueLookupAdapter(
            com.fathy.alfred.backend.calls.application.port.in.FindRecentRequestHeadersUseCase outbound,
            com.fathy.alfred.backend.internalcalls.application.port.in.FindRecentRequestHeadersUseCase inbound,
            ListCapturedCallsUseCase capturedOutboundList,
            com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase capturedOutboundDetail,
            ListCapturedInternalCallsUseCase capturedInboundList,
            com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase capturedInboundDetail) {
        this.outbound = outbound;
        this.inbound = inbound;
        this.capturedOutboundList = capturedOutboundList;
        this.capturedOutboundDetail = capturedOutboundDetail;
        this.capturedInboundList = capturedInboundList;
        this.capturedInboundDetail = capturedInboundDetail;
    }

    @Override
    public List<SessionValue> newest(String direction, String host, Set<String> names, String cycleId) {
        if (host == null || names == null || names.isEmpty()) {
            return List.of();
        }
        if (cycleId != null) {
            return newestFromCycle(direction, host, names, cycleId);
        }
        boolean isOutbound = "outbound".equals(direction);
        List<Map.Entry<String, Map<String, String>>> recent = isOutbound
                ? outbound.recentRequestHeaders(host, 200).stream()
                        .map(r -> Map.entry(r.callId(), r.headers())).toList()
                : inbound.recentRequestHeaders(host, 200).stream()
                        .map(r -> Map.entry(r.callId(), r.headers())).toList();
        return pickNewest(recent, names);
    }

    private List<SessionValue> newestFromCycle(String direction, String host, Set<String> names, String cycleId) {
        var query = new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "newest", 0, MAX_CYCLE_SCAN);
        if ("outbound".equals(direction)) {
            Optional<com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallsPage> page =
                    capturedOutboundList.listCalls(cycleId, query);
            if (page.isEmpty()) {
                return List.of();
            }
            return scanCycle(names, page.get().calls().stream()
                    .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary::call)
                    .filter(c -> host.equalsIgnoreCase(hostOf(c.url())))
                    .map(c -> c.id())
                    .toList(),
                    callId -> capturedOutboundDetail.getDetail(cycleId, callId)
                            .map(d -> d.request() != null ? d.request().headers() : null));
        }
        if ("inbound".equals(direction)) {
            var internalQuery = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery(
                    "", "", "newest", 0, MAX_CYCLE_SCAN, "", "", "");
            Optional<com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage> page =
                    capturedInboundList.listCalls(cycleId, internalQuery);
            if (page.isEmpty()) {
                return List.of();
            }
            return scanCycle(names, page.get().calls().stream()
                    .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary::call)
                    .filter(c -> host.equalsIgnoreCase(hostOf(c.url())))
                    .map(c -> c.id())
                    .toList(),
                    callId -> capturedInboundDetail.getDetail(cycleId, callId)
                            .map(d -> d.request() != null ? d.request().headers() : null));
        }
        return List.of();
    }

    private static List<SessionValue> scanCycle(Set<String> names, List<String> callIdsNewestFirst,
                                                  java.util.function.Function<String, Optional<Map<String, String>>> headersOf) {
        Map<String, SessionValue> found = new LinkedHashMap<>();
        for (String callId : callIdsNewestFirst) {
            if (found.size() == names.size()) {
                break;
            }
            Optional<Map<String, String>> headers = headersOf.apply(callId);
            if (headers.isEmpty()) {
                continue;
            }
            collect(found, names, callId, headers.get());
        }
        return List.copyOf(found.values());
    }

    private static List<SessionValue> pickNewest(List<Map.Entry<String, Map<String, String>>> recentNewestFirst, Set<String> names) {
        Map<String, SessionValue> found = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, String>> entry : recentNewestFirst) {
            if (found.size() == names.size()) {
                break;
            }
            collect(found, names, entry.getKey(), entry.getValue());
        }
        return List.copyOf(found.values());
    }

    private static void collect(Map<String, SessionValue> found, Set<String> names, String callId, Map<String, String> headers) {
        for (String name : names) {
            if (found.containsKey(name)) {
                continue;
            }
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (header.getKey().equalsIgnoreCase(name)) {
                    found.put(name, new SessionValue(header.getKey(), header.getValue(), callId));
                    break;
                }
            }
        }
    }

    private static String hostOf(String url) {
        try {
            return URI.create(url).getHost();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
