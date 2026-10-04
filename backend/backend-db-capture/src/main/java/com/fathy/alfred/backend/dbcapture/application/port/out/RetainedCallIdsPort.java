package com.fathy.alfred.backend.dbcapture.application.port.out;

import java.util.Set;

/**
 * Calls whose statements must survive the size cap - those a session cycle or a Relive cycle/run holds (FR-038).
 * Implemented in backend-app, which may read those slices; this slice may not.
 */
public interface RetainedCallIdsPort {
    Set<String> retainedCallIds();
}
