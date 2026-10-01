package com.fathy.alfred.backend.relivebridge;

import com.fathy.alfred.backend.calls.application.port.in.DeleteReliveCallsUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.in.DeleteInternalReliveCallsUseCase;
import com.fathy.alfred.backend.relive.application.port.out.RelatedCallsPort;
import org.springframework.stereotype.Component;

import java.util.Collection;

/** Deletes the logged calls of Relive runs from both call slices - outbound through
 *  {@code DeleteReliveCallsUseCase}, inbound through {@code DeleteInternalReliveCallsUseCase}.
 *  This bridge is the only place allowed to reach both slices on relive's behalf (ArchUnit keeps
 *  backend-relive itself isolated from them). */
@Component
public class RelatedCallsDeletionAdapter implements RelatedCallsPort {

    private final DeleteReliveCallsUseCase outboundCalls;
    private final DeleteInternalReliveCallsUseCase internalCalls;

    public RelatedCallsDeletionAdapter(DeleteReliveCallsUseCase outboundCalls,
                                       DeleteInternalReliveCallsUseCase internalCalls) {
        this.outboundCalls = outboundCalls;
        this.internalCalls = internalCalls;
    }

    @Override
    public int deleteByRunIds(Collection<String> runIds) {
        return outboundCalls.deleteByRunIds(runIds) + internalCalls.deleteByRunIds(runIds);
    }
}
