package com.fathy.alfred.backend.interception.application.port.out;

import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;

import java.util.List;

/**
 * Publishes the active rule set to wherever the proxy reads it from.
 *
 * <p>This is the whole of the backend→proxy channel for this feature, and it is a file rather than
 * a socket on purpose. The proxy evaluates rules locally against a cached snapshot so that no
 * proxied request ever costs a network round trip or a database query; a push channel would put
 * the backend's availability on the request path of every call, which is precisely what the
 * existing fire-and-forget webhook design exists to avoid.
 *
 * <p>The pattern is not new here either: {@code proxy/reverse-proxy-enabled.flag} is already
 * written by the backend, bind-mounted into the proxy containers and re-read by mtime on each
 * request (see FileLoggingToggleAdapter and log_and_route_reverse.py's _ToggleState). This is the
 * same mechanism carrying a richer payload.
 */
public interface RulesPublisherPort {

    /**
     * Called after every mutation. Implementations must write atomically - a proxy that reads a
     * half-written file disables interception until the next write (see the loader's error path),
     * which would turn every save into a brief outage of the feature.
     */
    void publish(boolean enabled, List<InterceptionRule> rules);
}
