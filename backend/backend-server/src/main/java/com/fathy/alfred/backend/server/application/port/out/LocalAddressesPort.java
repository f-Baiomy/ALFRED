package com.fathy.alfred.backend.server.application.port.out;

import java.util.Set;

/** This machine's own interface addresses: "local" in ALFRED_SETTINGS_EDIT_FROM covers them as well as loopback. */
public interface LocalAddressesPort {

    Set<String> addresses();
}
