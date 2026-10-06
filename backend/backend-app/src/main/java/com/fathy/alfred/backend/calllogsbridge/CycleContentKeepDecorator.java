package com.fathy.alfred.backend.calllogsbridge;

import com.fathy.alfred.backend.sessioncycles.application.port.out.SessionCycleNotificationPort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

/**
 * The session-cycle notifications, plus keeping cycle calls' log lines (specs/008-logs-call-link FR-005a): every
 * signal still reaches the WebSocket adapter (injected by name - this bridge never depends on a slice's adapter
 * class), then the keeper copies the changed cycle's lines in the background. The keeper is looked up lazily: it
 * reads session cycles, whose services depend on this port.
 */
@Primary
@Component
public class CycleContentKeepDecorator implements SessionCycleNotificationPort {

    private final SessionCycleNotificationPort delegate;
    private final ObjectProvider<CycleLogsKeeper> keeper;

    public CycleContentKeepDecorator(@Qualifier("webSocketSessionCycleNotificationAdapter") SessionCycleNotificationPort delegate,
                                     ObjectProvider<CycleLogsKeeper> keeper) {
        this.delegate = delegate;
        this.keeper = keeper;
    }

    @Override
    public void notifySessionCyclesChanged() {
        delegate.notifySessionCyclesChanged();
        keeper.ifAvailable(CycleLogsKeeper::cyclesChanged);
    }

    @Override
    public void notifyCycleContentChanged(String cycleId) {
        delegate.notifyCycleContentChanged(cycleId);
        keeper.ifAvailable(k -> k.cycleChanged(cycleId));
    }
}
