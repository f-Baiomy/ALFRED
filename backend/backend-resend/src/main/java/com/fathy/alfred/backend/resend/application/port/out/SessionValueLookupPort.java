package com.fathy.alfred.backend.resend.application.port.out;

import com.fathy.alfred.backend.resend.domain.model.SessionValue;

import java.util.List;
import java.util.Set;

/**
 * Finds the newest known value for each of {@code names} (cookie/authorization headers) among
 * calls to {@code host} - what {@code useCurrentSession} substitutes with. Implemented by
 * backend-app's resendbridge, over {@code FindRecentRequestHeadersUseCase} (both call slices) plus
 * a scan of a cycle's captured calls when {@code cycleId} is given.
 */
public interface SessionValueLookupPort {

    List<SessionValue> newest(String direction, String host, Set<String> names, String cycleId);
}
