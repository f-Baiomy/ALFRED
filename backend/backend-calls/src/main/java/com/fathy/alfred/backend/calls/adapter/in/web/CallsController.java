package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallsPage;
import com.fathy.alfred.backend.calls.domain.model.CallsQuery;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class CallsController {

    private final GetCallsUseCase getCallsUseCase;

    public CallsController(GetCallsUseCase getCallsUseCase) {
        this.getCallsUseCase = getCallsUseCase;
    }

    /** Server-side filtered/sorted/paginated - {@code offset}/{@code limit} drive "Load more" instead of the client re-slicing an already-fully-fetched array. */
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
}
