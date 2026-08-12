package com.fathy.alfred.backend.settings.application.port.in;

/**
 * The read path backend-app's CallFilterAdapter calls into on every incoming webhook call -
 * separate from GetCallFilterSettingsUseCase (which returns the whole settings object for the
 * Settings page) since this one only needs a yes/no answer for a single URL.
 */
public interface IsCallAllowedUseCase {

    boolean isAllowed(String url);
}
