package com.fathy.alfred.backend.internalcalls.adapter.in.web;

import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.internalcalls.domain.model.CallDetail;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsPage;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InternalCallsController {

    private final GetCallsUseCase getCallsUseCase;
    private final GetCallDetailUseCase getCallDetailUseCase;

    public InternalCallsController(GetCallsUseCase getCallsUseCase, GetCallDetailUseCase getCallDetailUseCase) {
        this.getCallsUseCase = getCallsUseCase;
        this.getCallDetailUseCase = getCallDetailUseCase;
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
            @RequestParam(defaultValue = "") String requestId
    ) {
        return getCallsUseCase.getCalls(new CallsQuery(search, supplier, sort, offset, limit, sessionId, operationId, requestId));
    }

    /** The full request/response (headers+bodies) for one call - fetched only once it's actually expanded. */
    @GetMapping("/internal-calls/{id}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id) {
        return getCallDetailUseCase.getDetail(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
