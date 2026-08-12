package com.fathy.alfred.backend.settings.application.port.in;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;

/** Add/toggle/remove for the "accept only" whitelist - one interface for all three, rather than three near-empty ones, since they're always used together (the same controller/component owns all of them). */
public interface ManageWhitelistUseCase {

    /** No-ops (returns current settings unchanged) if the normalized host is already present. */
    CallFilterSettings addWhitelistUrl(String host);

    /** @return current settings unchanged if no whitelist entry has this id. */
    CallFilterSettings toggleWhitelistUrl(String id, boolean enabled);

    CallFilterSettings removeWhitelistUrl(String id);
}
