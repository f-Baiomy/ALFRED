package com.fathy.alfred.backend.relive.application.port.in;

import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycleSummary;

import java.util.List;
import java.util.Optional;

/** Inbound port: cycle CRUD (FR-001-009). */
public interface ManageReliveCyclesUseCase {

    List<ReliveCycleSummary> list();

    Optional<ReliveCycle> get(String id);

    ReliveCycle create(ReliveCycle cycle);

    /** A "Relive now" quick run - created and returned already marked {@code transient}. */
    ReliveCycle createTransient(ReliveCycle cycle);

    /** @throws StaleCycleException when {@code ifMatch} doesn't match the stored {@code updatedAt}. */
    ReliveCycle update(String id, ReliveCycle cycle, String ifMatch, String reason);

    /** {@code name} overrides the default "<original name> (copy)" when given. */
    ReliveCycle duplicate(String id, String name);

    void delete(String id);
}
