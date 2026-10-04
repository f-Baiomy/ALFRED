package com.fathy.alfred.backend.relivebridge;

import com.fathy.alfred.backend.calls.application.port.in.DeleteReliveCallsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ReliveRunCyclesUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.DeleteInternalReliveCallsUseCase;
import com.fathy.alfred.backend.relive.application.port.out.RelatedCallsPort;
import org.springframework.stereotype.Component;

import java.util.Collection;

/** Deletes the logged calls of Relive runs from both call slices - outbound through
 *  {@code DeleteReliveCallsUseCase}, inbound through {@code DeleteInternalReliveCallsUseCase}.
 *  Also deletes the runs' own session cycles, and the database statements the runs' calls ran (by run tag). This bridge is the only place allowed to reach these slices on relive's behalf (ArchUnit keeps
 *  backend-relive itself isolated from them). */
@Component
public class RelatedCallsDeletionAdapter implements RelatedCallsPort {

    private final DeleteReliveCallsUseCase outboundCalls;
    private final DeleteInternalReliveCallsUseCase internalCalls;
    private final ReliveRunCyclesUseCase runCycles;
    private final DeleteCallStatementsUseCase dbStatements;

    public RelatedCallsDeletionAdapter(DeleteReliveCallsUseCase outboundCalls,
                                       DeleteInternalReliveCallsUseCase internalCalls,
                                       ReliveRunCyclesUseCase runCycles,
                                       DeleteCallStatementsUseCase dbStatements) {
        this.outboundCalls = outboundCalls;
        this.internalCalls = internalCalls;
        this.runCycles = runCycles;
        this.dbStatements = dbStatements;
    }

    @Override
    public int deleteRunCycles(Collection<String> runIds) {
        return runCycles.deleteForRuns(runIds);
    }

    @Override
    public int deleteByRunIds(Collection<String> runIds) {
        dbStatements.deleteForRuns(runIds);
        return outboundCalls.deleteByRunIds(runIds) + internalCalls.deleteByRunIds(runIds);
    }
}
