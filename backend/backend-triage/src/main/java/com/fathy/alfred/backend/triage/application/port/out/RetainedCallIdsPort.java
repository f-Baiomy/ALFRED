package com.fathy.alfred.backend.triage.application.port.out;

import java.util.Set;

/**
 * Calls a session cycle holds - their marks survive the row cap, so a cycle's triage never loses them. Implemented in
 * backend-app, which may read session cycles; this slice may not. Only asked when the cap is actually exceeded.
 */
public interface RetainedCallIdsPort {

    Set<String> retainedCallIds();
}
