package com.fathy.alfred.backend.dbcapture.application.port.out;

import com.fathy.alfred.backend.dbcapture.domain.model.CallMetadata;

import java.util.Map;
import java.util.Set;

/**
 * Method, path and status of recorded calls - implemented in backend-app (the calls slices own them), so "written by"
 * and key history can name the call that wrote a key (specs/011-redis-capture research R12). Optional: without it the
 * call id is shown alone.
 */
public interface CallMetadataPort {
    Map<String, CallMetadata> metadata(Set<String> callIds);
}
