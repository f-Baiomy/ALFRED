package com.fathy.alfred.backend.sessioncycles.application.port.out;

import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;

import java.util.List;
import java.util.Optional;

/** Outbound port: session-cycle metadata persistence, without the application core knowing it's a flat JSON file today. */
public interface SessionCycleMetadataStorePort {

    List<SessionCycle> findAll();

    Optional<SessionCycle> findById(String id);

    /** Upsert - a cycle with this id is replaced, otherwise it's added. */
    SessionCycle save(SessionCycle cycle);

    /** @return true if a cycle with this id existed and was deleted. */
    boolean deleteById(String id);

    /** Permanently deletes every session cycle - the Database settings tab's "Clear cycles" action (paired with CapturedCallsStorePort.deleteAll()). */
    void deleteAll();
}
