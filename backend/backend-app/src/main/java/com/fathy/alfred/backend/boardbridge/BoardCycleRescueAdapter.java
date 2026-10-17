package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.CycleDeletePlanUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.CycleRescuePort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Set;

/**
 * Before Session Cycles deletes a cycle it asks which of its calls boards mention (specs/027 FR-017, R7): those keep the
 * cycle alive as "kept from &lt;name&gt;", and the boards that mention none of them let it go.
 */
@Component
public class BoardCycleRescueAdapter implements CycleRescuePort {

    private final ObjectProvider<CycleDeletePlanUseCase> plans;

    public BoardCycleRescueAdapter(ObjectProvider<CycleDeletePlanUseCase> plans) {
        this.plans = plans;
    }

    @Override
    public Set<String> mentionedCalls(String cycleId) {
        CycleDeletePlanUseCase p = plans.getIfAvailable();
        return p == null ? Set.of() : p.plan(cycleId).callIds();
    }

    @Override
    public void kept(String cycleId) {
        CycleDeletePlanUseCase p = plans.getIfAvailable();
        if (p != null) {
            p.kept(cycleId);
        }
    }
}
