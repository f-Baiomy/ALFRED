package com.fathy.alfred.backend.logs.domain.model;

/** What happens to fields marked sensitive (FR-043). REDACT_AT_LOAD requires {@link RawMode#COPY}: with positions only, the unredacted original would still be readable. */
public enum PrivacyMode {
    SHOW, MASK, REDACT_AT_LOAD
}
