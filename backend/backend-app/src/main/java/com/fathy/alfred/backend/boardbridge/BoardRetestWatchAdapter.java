package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.RetestWatchUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/** Every completed inbound call is offered to the board's re-test watch by its project and endpoint (specs/016). */
@Component
public class BoardRetestWatchAdapter implements NewInternalCallObserverPort {

    /** Resolved on first use: the board reads calls and capture, which observe this - eager wiring would be a cycle. */
    private final ObjectProvider<RetestWatchUseCase> watch;
    private final NormalizeEndpointUseCase endpoints;

    public BoardRetestWatchAdapter(ObjectProvider<RetestWatchUseCase> watch, NormalizeEndpointUseCase endpoints) {
        this.watch = watch;
        this.endpoints = endpoints;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        try {
            if (call.method() != null && call.url() != null) {
                watch.getObject().callArrived(call.serviceName() == null ? "" : call.serviceName(), endpoints.endpointOf(call.method(), call.url()));
            }
        } catch (RuntimeException e) {
            // the watch never fails a call's completion
        }
        return List.of();
    }
}
