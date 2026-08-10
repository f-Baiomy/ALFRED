package com.fathy.alfred.backend.calls.adapter.in.web;

import com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
public class CallsController {

    private final GetCallsUseCase getCallsUseCase;

    public CallsController(GetCallsUseCase getCallsUseCase) {
        this.getCallsUseCase = getCallsUseCase;
    }

    /** Returns the most recent `limit` logged calls, newest first. */
    @GetMapping("/calls")
    public List<CallRecord> listCalls(@RequestParam(defaultValue = "50") int limit) {
        return getCallsUseCase.getCalls(limit);
    }
}
