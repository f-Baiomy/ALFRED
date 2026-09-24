package com.fathy.alfred.backend.callrefbridge;

import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * The one place backend-app turns a (direction, callId, cycleId) reference into a logged call -
 * outbound or inbound, live or captured in a session cycle. interceptionbridge and resendbridge
 * both delegate here and only project their half, so the four-way dispatch over the call slices'
 * use cases exists once rather than once per bridge.
 *
 * <p>A summary lookup (for method/url/serviceName/timestamp) and a detail lookup (for headers/body)
 * are two separate use cases in every slice - the same two calls GetCallsController and
 * GetCallDetailController already make. The summary lookup filters by requestId, which the slices
 * match as a substring with a page of one, so it can miss a call the detail lookup finds;
 * {@link #resolve} therefore tolerates a missing summary, while {@link #resolveListed} keeps the
 * stricter "must be listed too" rule resend has always applied.
 *
 * <p>The two call slices have identically named use cases and records, so they are referred to by
 * their full names here rather than imported.
 */
@Component
public class CallRefResolver {

    private final com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList;
    private final com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundList;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail;
    private final ListCapturedCallsUseCase capturedOutboundList;
    private final GetCapturedCallDetailUseCase capturedOutboundDetail;
    private final ListCapturedInternalCallsUseCase capturedInboundList;
    private final GetCapturedInternalCallDetailUseCase capturedInboundDetail;

    public CallRefResolver(com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundList,
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

    /**
     * The call's detail, plus its summary fields when the summary lookup finds it (method, url,
     * serviceName and timestamp are null otherwise). Empty for an unknown direction or when the
     * detail lookup finds nothing.
     */
    public Optional<ResolvedCall> resolve(String direction, String callId, String cycleId) {
        return resolve(direction, callId, cycleId, false);
    }

    /**
     * Like {@link #resolve}, but empty unless the summary lookup finds the call too - and in that
     * case the detail lookup is never made.
     */
    public Optional<ResolvedCall> resolveListed(String direction, String callId, String cycleId) {
        return resolve(direction, callId, cycleId, true);
    }

    private Optional<ResolvedCall> resolve(String direction, String callId, String cycleId, boolean requireSummary) {
        if ("outbound".equals(direction)) {
            return resolveOutbound(callId, cycleId, requireSummary);
        }
        if ("inbound".equals(direction)) {
            return resolveInbound(callId, cycleId, requireSummary);
        }
        return Optional.empty();
    }

    private Optional<ResolvedCall> resolveOutbound(String callId, String cycleId, boolean requireSummary) {
        Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> summary = callId == null ? Optional.empty()
                : cycleId == null ? findOutboundSummary(callId) : findCapturedOutboundSummary(cycleId, callId);
        if (requireSummary && summary.isEmpty()) {
            return Optional.empty();
        }
        return (cycleId == null ? outboundDetail.getDetail(callId) : capturedOutboundDetail.getDetail(cycleId, callId))
                .map(detail -> new ResolvedCall("outbound", callId, cycleId,
                        summary.map(com.fathy.alfred.backend.calls.domain.model.CallSummary::method).orElse(null),
                        summary.map(com.fathy.alfred.backend.calls.domain.model.CallSummary::url).orElse(null),
                        null,
                        summary.map(com.fathy.alfred.backend.calls.domain.model.CallSummary::timestamp).orElse(null),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null,
                        detail.response() != null ? detail.response().status() : null,
                        detail.response() != null ? detail.response().headers() : null,
                        detail.response() != null ? detail.response().body() : null));
    }

    private Optional<ResolvedCall> resolveInbound(String callId, String cycleId, boolean requireSummary) {
        Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> summary = callId == null ? Optional.empty()
                : cycleId == null ? findInboundSummary(callId) : findCapturedInboundSummary(cycleId, callId);
        if (requireSummary && summary.isEmpty()) {
            return Optional.empty();
        }
        return (cycleId == null ? inboundDetail.getDetail(callId) : capturedInboundDetail.getDetail(cycleId, callId))
                .map(detail -> new ResolvedCall("inbound", callId, cycleId,
                        summary.map(com.fathy.alfred.backend.internalcalls.domain.model.CallSummary::method).orElse(null),
                        summary.map(com.fathy.alfred.backend.internalcalls.domain.model.CallSummary::url).orElse(null),
                        summary.map(com.fathy.alfred.backend.internalcalls.domain.model.CallSummary::serviceName).orElse(null),
                        summary.map(com.fathy.alfred.backend.internalcalls.domain.model.CallSummary::timestamp).orElse(null),
                        detail.request() != null ? detail.request().headers() : null,
                        detail.request() != null ? detail.request().body() : null,
                        detail.response() != null ? detail.response().status() : null,
                        detail.response() != null ? detail.response().headers() : null,
                        detail.response() != null ? detail.response().body() : null));
    }

    private Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> findOutboundSummary(String callId) {
        var query = new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return outboundList.getCalls(query).calls().stream().filter(c -> callId.equals(c.id())).findFirst();
    }

    private Optional<com.fathy.alfred.backend.calls.domain.model.CallSummary> findCapturedOutboundSummary(String cycleId, String callId) {
        var query = new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return capturedOutboundList.listCalls(cycleId, query)
                .flatMap(page -> page.calls().stream()
                        .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCallSummary::call)
                        .filter(c -> callId.equals(c.id()))
                        .findFirst());
    }

    private Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> findInboundSummary(String callId) {
        var query = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return inboundList.getCalls(query).calls().stream().filter(c -> callId.equals(c.id())).findFirst();
    }

    private Optional<com.fathy.alfred.backend.internalcalls.domain.model.CallSummary> findCapturedInboundSummary(String cycleId, String callId) {
        var query = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "newest", 0, 1, "", "", callId);
        return capturedInboundList.listCalls(cycleId, query)
                .flatMap(page -> page.calls().stream()
                        .map(com.fathy.alfred.backend.sessioncycles.domain.model.CapturedInternalCallSummary::call)
                        .filter(c -> callId.equals(c.id()))
                        .findFirst());
    }
}
