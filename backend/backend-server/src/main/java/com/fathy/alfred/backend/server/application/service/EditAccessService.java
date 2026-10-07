package com.fathy.alfred.backend.server.application.service;

import com.fathy.alfred.backend.server.application.port.in.EditAccessUseCase;
import com.fathy.alfred.backend.server.application.port.out.DefaultsPort;
import com.fathy.alfred.backend.server.application.port.out.EnvFilePort;
import com.fathy.alfred.backend.server.application.port.out.LocalAddressesPort;
import com.fathy.alfred.backend.server.domain.model.AccessRule;
import com.fathy.alfred.backend.server.domain.model.EditAccess;
import com.fathy.alfred.backend.server.domain.model.RuntimeMode;

import java.util.Set;

/**
 * Decides with the CURRENT value of ALFRED_SETTINGS_EDIT_FROM, read from .env on every write request, so narrowing it
 * applies to the very next request (LIVE). .env is small and the check runs on writes only.
 */
public class EditAccessService implements EditAccessUseCase {

    private static final String KEY = "ALFRED_SETTINGS_EDIT_FROM";

    private final EnvFilePort envFile;
    private final DefaultsPort defaults;
    private final LocalAddressesPort localAddresses;
    private final RuntimeMode mode;

    public EditAccessService(EnvFilePort envFile, DefaultsPort defaults, LocalAddressesPort localAddresses, RuntimeMode mode) {
        this.envFile = envFile;
        this.defaults = defaults;
        this.localAddresses = localAddresses;
        this.mode = mode;
    }

    @Override
    public EditAccess access(String peerAddress, Set<String> headerNames) {
        String setting = mode == RuntimeMode.NATIVE
                ? envFile.read().get(KEY).orElseGet(() -> defaults.defaults().getOrDefault(KEY, "local,lan"))
                : "";
        return AccessRule.parse(setting).decide(peerAddress, headerNames, localAddresses.addresses(), mode);
    }
}
