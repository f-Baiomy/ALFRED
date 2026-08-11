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
            @RequestParam(defaultValue = "10") int limit
    ) {
        return getCallsUseCase.getCalls(new CallsQuery(search, supplier, sort, offset, limit));
    }

    /** The full request/response (headers+bodies) for one call - fetched only once it's actually expanded, not up front with every call in the list. */
    @GetMapping("/calls/{id}/detail")
    public ResponseEntity<CallDetail> getDetail(@PathVariable String id) {
        return getCallDetailUseCase.getDetail(id)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
