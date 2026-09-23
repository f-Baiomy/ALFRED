package com.fathy.alfred.backend.interception.adapter.out.rulesfile;

import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Builds the {@link SelfTargets} this deployment has, from settings it already carries. Nothing
 * new to configure: the backend and gateway ports, the forward proxy's listeners, and every
 * reverse-proxy listenPort from INTERNAL_CALL_SERVICES are all known here already.
 */
@Configuration
public class SelfTargetsConfig {

    /** docker-compose.yml's service names - each is Alfred on every port. */
    private static final List<String> SERVICE_NAMES =
            List.of("backend", "app-gateway", "proxy", "reverse-proxy", "frontend");

    /** How a caller on the host reaches a container port Alfred publishes. */
    private static final List<String> LOOPBACK_NAMES = List.of("localhost", "127.0.0.1", "host.docker.internal");

    /**
     * The gateway's published port. A literal on purpose: docker-compose.yml maps app-gateway as
     * `3000:80` with no variable, so there is no setting to read it from.
     */
    private static final int GATEWAY_PORT = 3000;

    @Bean
    public SelfTargets selfTargets(
            @Value("${BACKEND_PORT:5000}") int backendPort,
            @Value("${FORWARD_PROXY_DEFAULT_PORT:8080}") int forwardProxyPort,
            @Value("${INTERNAL_CALL_SERVICES:}") String internalCallServices) {
        Set<Integer> ports = new HashSet<>(List.of(backendPort, GATEWAY_PORT, forwardProxyPort));
        ports.addAll(listenPorts(internalCallServices));

        Set<String> hostPorts = new HashSet<>();
        for (String name : LOOPBACK_NAMES) {
            for (int port : ports) {
                hostPorts.add(name + ":" + port);
            }
        }
        // The forward proxy's published host address (docker-compose.yml: 127.0.0.2:443:8080).
        hostPorts.add("127.0.0.2:443");
        return new SelfTargets(Set.copyOf(SERVICE_NAMES), hostPorts);
    }

    /** `name:listenPort:upstreamPort` triples, comma-separated - the same shape the reverse proxy reads. */
    static Set<Integer> listenPorts(String services) {
        Set<Integer> ports = new HashSet<>();
        if (services == null || services.isBlank()) {
            return ports;
        }
        for (String triple : services.split(",")) {
            String[] parts = triple.strip().split(":");
            if (parts.length >= 2) {
                try {
                    ports.add(Integer.parseInt(parts[1].strip()));
                } catch (NumberFormatException ignored) {
                    // A malformed entry is the reverse proxy's problem to report; it simply adds no port here.
                }
            }
        }
        return ports;
    }
}
