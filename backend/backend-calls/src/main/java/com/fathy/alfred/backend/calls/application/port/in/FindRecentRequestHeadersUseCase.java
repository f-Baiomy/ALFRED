package com.fathy.alfred.backend.calls.application.port.in;

import com.fathy.alfred.backend.calls.domain.model.RecentRequestHeaders;

import java.util.List;

/**
 * The newest logged calls to a given host, request headers only - what backend-resend's
 * {@code useCurrentSession} scans for the newest cookie/authorization value, through backend-app's
 * resendbridge. Never a body: this exists to be cheap to compute for every resend, not to serve a
 * call detail view.
 */
public interface FindRecentRequestHeadersUseCase {

    /** {@code limit} is clamped to 200 - see CallLogPort.MAX_RECENT_REQUEST_HEADERS. */
    List<RecentRequestHeaders> recentRequestHeaders(String host, int limit);
}
