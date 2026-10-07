package com.fathy.alfred.backend.server.domain.model;

/**
 * One inbound project of INTERNAL_CALL_SERVICES: callers use {@code listenPort}, Alfred forwards to the app's own
 * {@code upstreamPort}. The optional outbound address gives the project its own forward-proxy listener so its
 * outbound calls are attributed to it ({@code outboundPort} is 443 when only the host is given).
 */
public record Project(String name, int listenPort, int upstreamPort, String outboundHost, Integer outboundPort) {

    public String serialize() {
        String base = name + ":" + listenPort + ":" + upstreamPort;
        return outboundHost == null ? base : base + ":" + outboundHost + ":" + outboundPort;
    }
}
