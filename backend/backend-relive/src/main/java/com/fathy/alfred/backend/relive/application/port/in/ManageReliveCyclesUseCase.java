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

    /** {@code deferFingerprint} stores the steps with no hash. {@link #fingerprint(String)} stamps them later. */
    ReliveCycle create(ReliveCycle cycle, boolean deferFingerprint);

    /** A "Relive now" quick run - created and returned already marked {@code transient}. */
    ReliveCycle createTransient(ReliveCycle cycle);

    ReliveCycle createTransient(ReliveCycle cycle, boolean deferFingerprint);

    /**
     * Stamps outbound steps that have no SEMANTIC_V1 hash and saves the cycle.
     * A cycle that is already stamped is returned unchanged, including its {@code updatedAt}.
     */
    ReliveCycle fingerprint(String id);

    /**
     * Recomputes every outbound hash to the current algorithm, refreshes the parent → hash →
     * calls index, and saves. {@code rebuild} false is {@link #fingerprint(String)}.
     */
    ReliveCycle fingerprint(String id, boolean rebuild);

    /** @throws StaleCycleException when {@code ifMatch} doesn't match the stored {@code updatedAt}. */
    ReliveCycle update(String id, ReliveCycle cycle, String ifMatch, String reason);

    /** {@code name} overrides the default "<original name> (copy)" when given. */
    ReliveCycle duplicate(String id, String name);

    void delete(String id);

    /** "Save as cycle" for a "Relive now" quick run (FR-003c): it stops being transient and is
     *  kept, with its runs, from now on. */
    ReliveCycle keep(String id);
}
