package com.fathy.alfred.backend.relive.application.port.out;

import com.fathy.alfred.backend.relive.domain.model.LiveCall;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** Outbound port: the Live calls log (FR-015b) - deliberately never pruned automatically. */
public interface LiveCallStorePort {

    LiveCall add(LiveCall call);

    /** Newest first, without {@code request}/{@code response} bodies. */
    List<LiveCall> list(String cycleId, int limit);

    Optional<LiveCall> findById(String id);

    boolean deleteById(String id);

    /** Drives the "warn above 200 MB" size display (FR-015c). */
    long totalBytes(String cycleId);

    /** Removes the Live-calls rows recorded while the given runs were active - only ever called
     *  from the explicit history delete, and only when the user chose to delete the related
     *  calls; keeping them is the default. */
    void deleteByRunIds(Collection<String> runIds);
}
