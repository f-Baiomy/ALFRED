package com.fathy.alfred.backend.dbcapturebridge;

import com.fathy.alfred.backend.dbcapture.application.port.out.RetainedCallIdsPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.Set;

/**
 * The inbound calls session cycles hold - their statements survive db-capture.db's size cap (FR-038). Lives here
 * because backend-db-capture may not read backend-session-cycles. Only asked when the cap is actually exceeded.
 * Relive runs need no bridge: their statements carry the run tag and the store keeps them by it.
 */
@Component
public class RetainedCallIdsAdapter implements RetainedCallIdsPort {

    private static final int PAGE = 500;

    private final ListSessionCyclesUseCase cycles;
    private final ListCapturedInternalCallsUseCase capturedInternalCalls;

    public RetainedCallIdsAdapter(ListSessionCyclesUseCase cycles, ListCapturedInternalCallsUseCase capturedInternalCalls) {
        this.cycles = cycles;
        this.capturedInternalCalls = capturedInternalCalls;
    }

    @Override
    public Set<String> retainedCallIds() {
        Set<String> ids = new HashSet<>();
        for (SessionCycle cycle : cycles.listAll()) {
            int offset = 0;
            while (true) {
                var page = capturedInternalCalls.listCalls(cycle.id(), new CallsQuery("", "", "oldest", offset, PAGE, "", "", "", "", ""));
                if (page.isEmpty() || page.get().calls().isEmpty()) {
                    break;
                }
                page.get().calls().forEach(captured -> ids.add(captured.call().id()));
                offset += page.get().calls().size();
                if (offset >= page.get().total()) {
                    break;
                }
            }
        }
        return ids;
    }
}
