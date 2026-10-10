package com.fathy.alfred.backend.calls.application.port.out;

import java.util.Set;

/**
 * Calls the size and count limits must never delete - those with a comment, while the storage page's rule is on.
 * backend-app implements it (it reads backend-comments); a store without it trims oldest-first as before.
 */
public interface KeptCallIdsPort {

    Set<String> keptCallIds();
}
