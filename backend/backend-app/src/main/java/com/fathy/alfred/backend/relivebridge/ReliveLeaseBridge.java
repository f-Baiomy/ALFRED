package com.fathy.alfred.backend.relivebridge;

import com.fathy.alfred.backend.relive.adapter.out.websocket.LeaseListener;
import com.fathy.alfred.backend.relive.adapter.out.websocket.ReliveEventsWebSocketHandler;
import com.fathy.alfred.backend.relive.application.service.RunLeaseRegistry;
import org.springframework.stereotype.Component;

/**
 * Wires backend-relive's RunLeaseRegistry (T047) to /ws/relive's lease events. Lives in
 * backend-app, the composition root, because RunLeaseRegistry (application.service) must not
 * depend on adapter.out.websocket directly (ArchUnit's applicationMustNotDependOnAdapter) - the
 * same reasoning as RuleValidationAdapter/GlobalRulesLookupAdapter in this package.
 */
@Component
public class ReliveLeaseBridge implements LeaseListener {

    private final RunLeaseRegistry runLeaseRegistry;

    public ReliveLeaseBridge(RunLeaseRegistry runLeaseRegistry, ReliveEventsWebSocketHandler webSocketHandler) {
        this.runLeaseRegistry = runLeaseRegistry;
        webSocketHandler.addLeaseListener(this);
    }

    @Override
    public void onLeaseHeld(String runId, String sessionId) {
        runLeaseRegistry.onLeaseHeld(runId, sessionId);
    }

    @Override
    public void onSessionClosed(String sessionId) {
        runLeaseRegistry.onSessionClosed(sessionId);
    }
}
