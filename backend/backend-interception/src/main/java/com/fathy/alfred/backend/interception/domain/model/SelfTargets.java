package com.fathy.alfred.backend.interception.domain.model;

import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * Where a REWRITE_URL may never send a call: Alfred itself. A rewrite into the backend, the
 * gateway or one of the proxy's own listeners would loop, or post into Alfred with the proxy's
 * identity. Everything else - including other internal addresses - is allowed (Clarification Q1).
 *
 * <p>{@code hosts} is a bare name that is Alfred on any port (a compose service name);
 * {@code hostPorts} is {@code host:port}, for names such as {@code localhost} that are only
 * Alfred on specific ports. Checked at save time by RuleValidator, and published in the snapshot
 * so the proxy can re-check a pattern rewrite, whose result is only known at run time.
 */
public record SelfTargets(Set<String> hosts, Set<String> hostPorts) {

    public SelfTargets {
        hosts = hosts == null ? Set.of() : Set.copyOf(hosts);
        hostPorts = hostPorts == null ? Set.of() : Set.copyOf(hostPorts);
    }

    public static SelfTargets none() {
        return new SelfTargets(Set.of(), Set.of());
    }

    public boolean includes(String host, Integer port) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.strip().toLowerCase(Locale.ROOT);
        if (hosts.contains(h)) {
            return true;
        }
        return port != null && hostPorts.contains(h + ":" + port);
    }

    /** The flat list the snapshot carries: every bare host, then every host:port. */
    public Set<String> published() {
        Set<String> all = new TreeSet<>(hosts);
        all.addAll(hostPorts);
        return all;
    }
}
