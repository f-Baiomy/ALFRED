package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * Where a call is in its two-phase lifecycle - distinct from the HTTP status code carried in
 * {@link ResponseData}. {@code IN_PROGRESS} from the moment the proxy intercepts a request
 * (before the upstream response arrives) until either a response comes back ({@code COMPLETED},
 * regardless of the HTTP status code - a 404 or 500 is still a completed call) or the proxy
 * reports it never got one ({@code ERROR} - connection refused, timeout, etc).
 */
public enum CallLifecycleStatus {
    IN_PROGRESS,
    COMPLETED,
    ERROR
}
