package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallDetail;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CallsController {

    private final GetCallsUseCase getCallsUseCase;
    private final GetCallDetailUseCase getCallDetailUseCase;

    public CallsController(GetCallsUseCase getCallsUseCase, GetCallDetailUseCase getCallDetailUseCase) {
        this.getCallsUseCase = getCallsUseCase;
        this.getCallDetailUseCase = getCallDetailUseCase;
    }

    /** Server-side filtered/sorted/paginated - {@code offset}/{@code limit} drive "Load more" instead of the client re-slicing an already-fully-fetched array. Returns CallSummary (no request/response headers/bodies) - see GET /calls/{id}/detail for those. */
    @GetMapping("/calls")
    public CallsPage listCalls(
            @RequestParam(defaultValue = "") String search,
            @RequestParam(defaultValue = "") String supplier,
            @RequestParam(defaultValue = "newest") String sort,
            @RequestParam(defaultValue = "0") int offset,
            @RequestParam(defaultValue = "10") int limit,
            @RequestParam(defaultValue = "") String sessionId,
            @RequestParam(defaultValue = "") String operationId,
            @RequestParam(defaultValue = "") String requestId
    ) {
        return getCallsUseCase.getCalls(new CallsQuery(search, supplier, sort, offset, limit, sessionId, operationId, requestId));
    }

    /**
     * The request/response (headers+bodies) for one call - fetched only once it's actually expanded,
     * not up front with every call in the list.
     *
     * {@code part} narrows the payload to one of request-headers/request-body/response-headers/
     * response-body, for a client that expanded a single block (see CallDetail.part). Omitted - or
     * unrecognised - returns the whole detail exactly as before, which is what the export path and
     * every pre-existing caller relies on.
     */
    @GetMapping("/calls/{id}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id, @RequestParam(required = false) String part) {
        return getCallDetailUseCase.getDetail(id)
                .map(detail -> detail.part(part))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
