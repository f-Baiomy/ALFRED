package com.fathy.alfred.backend.settings.application.port.in;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;

/** Add/remove for the blacklist - no toggle (unlike the whitelist); removing IS how you temporarily/permanently stop blocking a host. */
public interface ManageBlacklistUseCase {

    /** No-ops (returns current settings unchanged) if the normalized host is already present. */
    CallFilterSettings addBlacklistUrl(String host);

    CallFilterSettings removeBlacklistUrl(String id);
}
