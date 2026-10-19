package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.Self;

import java.time.Instant;
import java.util.List;

/**
 * Other Alfreds on the LAN (D33). Natively the supervisor sends and hears the datagrams; in Docker a container cannot
 * see the LAN, so the page says to type the address instead.
 */
public interface DiscoveryPort {

    record Found(String alfredId, String name, String address, String version, Instant seenAt) {
    }

    record Heard(boolean available, String why, List<Found> found) {
    }

    /** Tells the announcer who this Alfred is and whether it announces (a no-op where there is none). */
    void announce(Self self);

    Heard heard();
}
