package com.fathy.alfred.backend.internalcalls.application.port.out;

/**
 * Outbound port: whether the reverse-mode mitmproxy in front of WildFly (wildfly-proxy, see
 * proxy/log_and_route_reverse.py) should log calls to this slice's webhook right now. Forwarding
 * to WildFly itself is never affected either way - this only controls logging, exactly like the
 * existing toggle-wildfly-reverse-proxy.sh/.bat scripts (and start.py/restart.py's
 * --wildfly-reverse-proxy flag) already do by hand-editing the same flag file. This port exists so
 * the frontend can flip the same switch from a button instead of a terminal.
 */
public interface LoggingTogglePort {

    boolean isEnabled();

    void setEnabled(boolean enabled);
}
