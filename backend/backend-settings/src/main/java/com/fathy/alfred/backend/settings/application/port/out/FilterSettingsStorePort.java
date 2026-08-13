package com.fathy.alfred.backend.settings.application.port.out;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;

/** Outbound port: persistence for the single global CallFilterSettings instance. */
public interface FilterSettingsStorePort {

    /** @return the persisted settings, or CallFilterSettings.defaults() if nothing has been saved yet. */
    CallFilterSettings load();

    CallFilterSettings save(CallFilterSettings settings);

    /** Bytes currently occupied on disk by this adapter's storage - drives the Database settings tab's file-size table. */
    long storageSizeBytes();
}
