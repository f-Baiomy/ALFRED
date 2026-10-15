package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.RequirementWatchUseCase;
import com.fathy.alfred.backend.board.application.port.in.RetestWatchUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/** Every completed inbound call is offered to the board's re-test watch (specs/016) and requirement check (specs/018) by its project and endpoint. */
@Component
public class BoardRetestWatchAdapter implements NewInternalCallObserverPort {

    /** Resolved on first use: the board reads calls and capture, which observe this - eager wiring would be a cycle. */
    private final ObjectProvider<RetestWatchUseCase> watch;
    private final ObjectProvider<RequirementWatchUseCase> requirements;
    private final NormalizeEndpointUseCase endpoints;
    private final ObjectProvider<com.fathy.alfred.backend.board.application.port.in.ChatWatchUseCase> chatWatches;

    public BoardRetestWatchAdapter(ObjectProvider<RetestWatchUseCase> watch, ObjectProvider<RequirementWatchUseCase> requirements,
                                   NormalizeEndpointUseCase endpoints,
                                   ObjectProvider<com.fathy.alfred.backend.board.application.port.in.ChatWatchUseCase> chatWatches) {
        this.watch = watch;
        this.requirements = requirements;
        this.endpoints = endpoints;
        this.chatWatches = chatWatches;
    }

    @Override
    public List<String> onCallCompleted(CallRecord call) {
        try {
            if (call.method() != null && call.url() != null) {
                String project = call.serviceName() == null ? "" : call.serviceName();
                String endpoint = endpoints.endpointOf(call.method(), call.url());
                watch.getObject().callArrived(project, endpoint);
                // specs/018: the requirement check judges the call on its own thread
                RequirementWatchUseCase check = requirements.getIfAvailable();
                if (check != null) {
                    check.callArrived(project, endpoint);
                }
                // specs/022: the board chats' "tell me when" and "watch while I test" (queued, never slows the call)
                var chat = chatWatches.getIfAvailable();
                if (chat != null) {
                    chat.callCompleted(project, call.id(), endpoint, call.response() == null ? null : call.response().status());
                }
            }
        } catch (RuntimeException e) {
            // the watch never fails a call's completion
        }
        return List.of();
    }
}
