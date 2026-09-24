package com.fathy.alfred.backend.resendbridge;

import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.List;
import java.util.Optional;

/**
 * Bridges backend-resend's CallSourcePort to the call slices - outbound or inbound, live or
 * captured in a session cycle. Lives in backend-app for the same reason as CallFilterAdapter and
 * RecordedCallLookupAdapter: resend must not depend on any call slice, and this composition root
 * is the only place allowed to know them all.
 *
 * <p>A summary lookup (for method/url/serviceName) and a detail lookup (for headers/body) are two
 * separate use cases in every slice - the same two calls GetCallsController/GetCallDetailController
 * already make - so this makes both rather than adding a new "give me the whole CallRecord" port
 * just for this one caller.
 */
@Component
public class CallSourceAdapter implements CallSourcePort {

    private final com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList;
    private final com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundList;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail;
    private final ListCapturedCallsUseCase capturedOutboundList;
    private final GetCapturedCallDetailUseCase capturedOutboundDetail;
    private final ListCapturedInternalCallsUseCase capturedInboundList;
    private final GetCapturedInternalCallDetailUseCase capturedInboundDetail;

    public CallSourceAdapter(com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList,
                              com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail,
                              com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundList,
                              com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail,
                              ListCapturedCallsUseCase capturedOutboundList,
                              GetCapturedCallDetailUseCase capturedOutboundDetail,
                              ListCapturedInternalCallsUseCase capturedInboundList,
                              GetCapturedInternalCallDetailUseCase capturedInboundDetail) {
        this.outboundList = outboundList;
        this.outboundDetail = outboundDetail;
        this.inboundList = inboundList;
        this.inboundDetail = inboundDetail;
        this.capturedOutboundList = capturedOutboundList;
        this.capturedOutboundDetail = capturedOutboundDetail;
        this.capturedInboundList = capturedInboundList;
        this.capturedInboundDetail = capturedInboundDetail;
    }

    @Override
    public Optional<StoredCall> load(String direction, String callId, String cycleId) {
        if (callId == null) {
            return Optional.empty();
        }
        if ("outbound".equals(direction)) {
            return cycleId == null ? loadOutbound(callId) : loadCapturedOutbound(cycleId, callId);
        }
        if ("inbound".equals(direction)) {
            return cycleId == null ? loadInbound(callId) : loadCapturedInbound(cycleId, callId);
        }
        return Optional.empty();
    }

    private Optional<StoredCall> loadOutbound(String callId) {
        Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> summary = findOutboundSummary(callId);
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        return outboundDetail.getDetail(callId)
                .map(detail -> toStoredCall("outbound", callId, summary.get().method(), summary.get().url(),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null, null));
    }

    private Optional<StoredCall> loadCapturedOutbound(String cycleId, String callId) {
        Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> summary = findCapturedOutboundSummary(cycleId, callId);
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        return capturedOutboundDetail.getDetail(cycleId, callId)
                .map(detail -> toStoredCall("outbound", callId, summary.get().method(), summary.get().url(),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null, null));
    }

    private Optional<StoredCall> loadInbound(String callId) {
        var query = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        List<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> matches = inboundList.getCalls(query).calls();
        Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> summary =
                matches.stream().filter(c -> callId.equals(c.id())).findFirst();
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        return inboundDetail.getDetail(callId)
                .map(detail -> toStoredCall("inbound", callId, summary.get().method(), summary.get().url(),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null, summary.get().serviceName()));
    }

    private Optional<StoredCall> loadCapturedInbound(String cycleId, String callId) {
        var query = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        Optional<com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallsPage> page =
                capturedInboundList.listCalls(cycleId, query);
        if (page.isEmpty()) {
            return Optional.empty();
        }
        Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> summary = page.get().calls().stream()
                .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary::call)
                .filter(c -> callId.equals(c.id()))
                .findFirst();
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        return capturedInboundDetail.getDetail(cycleId, callId)
                .map(detail -> toStoredCall("inbound", callId, summary.get().method(), summary.get().url(),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null, summary.get().serviceName()));
    }

    private Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> findOutboundSummary(String callId) {
        var query = new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return outboundList.getCalls(query).calls().stream().filter(c -> callId.equals(c.id())).findFirst();
    }

    private Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> findCapturedOutboundSummary(String cycleId, String callId) {
        var query = new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return capturedOutboundList.listCalls(cycleId, query)
                .map(page -> page.calls().stream()
                        .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary::call)
                        .filter(c -> callId.equals(c.id()))
                        .findFirst())
                .orElse(Optional.empty());
    }

    private static StoredCall toStoredCall(String direction, String callId, String method, String url,
                                            java.util.Map<String, String> headers, String body, String serviceName) {
        return new StoredCall(direction, callId, method, url, headers, body, hostOf(url), serviceName);
    }

    private static String hostOf(String url) {
        try {
            return URI.create(url).getHost();
        } catch (RuntimeException e) {
            return null;
        }
    }
}
