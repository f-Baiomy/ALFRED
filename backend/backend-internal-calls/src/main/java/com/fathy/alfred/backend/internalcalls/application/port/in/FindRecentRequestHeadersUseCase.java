package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.RecentRequestHeaders;

import java.util.List;

/** Request headers of the newest calls to one host - never bodies. Backs "resend with current session". */
public interface FindRecentRequestHeadersUseCase {
    int MAX_LIMIT = 200;

    /** @param authority host[:port], lower-case; newest first; at most min(limit, MAX_LIMIT) rows */
    List<RecentRequestHeaders> findRecent(String authority, int limit);
}
