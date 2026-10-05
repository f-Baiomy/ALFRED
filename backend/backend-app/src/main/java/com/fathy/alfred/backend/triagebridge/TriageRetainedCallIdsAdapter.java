package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.triage.application.port.out.RetainedCallIdsPort;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

/**
 * Every call a session cycle holds, inbound and outbound - their triage marks survive triage.db's row cap. Lives here
 * because backend-triage may not read backend-session-cycles. Only asked when the cap is actually exceeded.
 */
@Component
public class TriageRetainedCallIdsAdapter implements RetainedCallIdsPort {

    private final ListSessionCyclesUseCase cycles;
    private final CycleCallsReader reader;

    public TriageRetainedCallIdsAdapter(ListSessionCyclesUseCase cycles, ListCapturedCallsUseCase capturedCalls,
                                        ListPagedCapturedInternalCallsUseCase capturedInternalCalls) {
        this.cycles = cycles;
        this.reader = new CycleCallsReader(capturedCalls, capturedInternalCalls);
    }

    @Override
    public Set<String> retainedCallIds() {
        Set<String> ids = new HashSet<>();
        for (SessionCycle cycle : cycles.listAll()) {
            reader.inbound(cycle.id(), summary -> ids.add(summary.call().id()));
            reader.outbound(cycle.id(), summary -> ids.add(summary.call().id()));
        }
        return ids;
    }
}
