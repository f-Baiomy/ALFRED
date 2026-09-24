package com.fathy.alfred.backend.internalcalls.application.port.in;

import com.fathy.alfred.backend.internalcalls.domain.model.RecentRequestHeaders;

import java.util.List;

/** The inbound-ring equivalent of backend-calls' own use case of the same name. */
public interface FindRecentRequestHeadersUseCase {

    List<RecentRequestHeaders> recentRequestHeaders(String host, int limit);
}
