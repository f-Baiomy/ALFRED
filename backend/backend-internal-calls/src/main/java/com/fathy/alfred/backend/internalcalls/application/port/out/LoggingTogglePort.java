package com.fathy.alfred.backend.internalcalls.application.port.out;

/**
 * Outbound port: whether reverse-proxy (see proxy/log_and_route_reverse.py) should log calls
 * for a given project NAME right now. Forwarding to that project's upstream is never affected
 * either way - this only controls logging, exactly like the existing
 * toggle-wildfly-reverse-proxy.sh/.bat <name> scripts already do by hand-editing the same flag
 * file. This port exists so the frontend can flip the same switch from a button instead of a
 * terminal. Every name is independent - there is no single "all projects" switch.
 */
public interface LoggingTogglePort {

    boolean isEnabled(String name);

    void setEnabled(String name, boolean enabled);
}
