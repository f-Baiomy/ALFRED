package com.fathy.alfred.backend.settings.domain.model;

/** ACCEPT_ALL logs every call not on the blacklist; ACCEPT_ONLY logs only calls matching an enabled whitelist entry (still subject to the blacklist first). */
public enum FilterMode {
    ACCEPT_ALL,
    ACCEPT_ONLY
}
