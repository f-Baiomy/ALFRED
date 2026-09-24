package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallBaselineUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetWsMessagesUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallBaseline;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.internalcalls.domain.model.WsMessagesPage;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InternalCallsController {

    private final GetCallsUseCase getCallsUseCase;
    private final GetCallDetailUseCase getCallDetailUseCase;
    private final GetCallBaselineUseCase getCallBaselineUseCase;
    private final GetWsMessagesUseCase getWsMessagesUseCase;

    public InternalCallsController(GetCallsUseCase getCallsUseCase, GetCallDetailUseCase getCallDetailUseCase,
                                    GetCallBaselineUseCase getCallBaselineUseCase, GetWsMessagesUseCase getWsMessagesUseCase) {
        this.getCallsUseCase = getCallsUseCase;
        this.getCallDetailUseCase = getCallDetailUseCase;
        this.getCallBaselineUseCase = getCallBaselineUseCase;
        this.getWsMessagesUseCase = getWsMessagesUseCase;
    }

    /** Server-side filtered/sorted/paginated - {@code offset}/{@code limit} drive "Load more". Returns CallSummary (no request/response headers/bodies) - see GET /internal-calls/{id}/detail for those. */
    @GetMapping("/internal-calls")
    public CallsPage listCalls(
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "newest") String sort,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "10") int limit,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId,
            @RequestParam(defaultValue = "") String serviceNames
    ) {
        return getCallsUseCase.getCalls(new CallsQuery(search, supplier, sort, offset, limit, sessionId, operationId, requestId, serviceNames));
    }

    /**
     * The request/response (headers+bodies) for one call - fetched only once it's actually expanded.
     *
     * {@code part} narrows the payload to one of request-headers/request-body/response-headers/
     * response-body (see CallDetail.part). Omitted - or unrecognised - returns the whole detail
     * exactly as before.
     */
    @GetMapping("/internal-calls/{id}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id, @RequestParam(required = false) String part) {
        return getCallDetailUseCase.getDetail(id)
                .map(detail -> detail.part(part))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /** Mirrors GET /calls/baseline for inbound endpoints - see backend-calls' CallsController. */
    @GetMapping("/internal-calls/baseline")
    public CallBaseline getBaseline(@RequestParam String url) {
        return getCallBaselineUseCase.getBaseline(url);
    }

    /** {@code limit} is clamped to 1..500 server-side - see GetWsMessagesUseCase. */
    @GetMapping("/internal-calls/{id}/ws-messages")
    public WsMessagesPage getWsMessages(@PathVariable String id,
                                         @RequestParam(defaultValue = "0") int offset,
                                         @RequestParam(defaultValue = "200") int limit) {
        return getWsMessagesUseCase.getWsMessages(id, offset, limit);
    }
}
