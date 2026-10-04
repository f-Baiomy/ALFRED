package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.DbCaptureSettings;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;

import java.util.List;

/** The per-project switch and settings (contracts/rest-api.md). Every change is broadcast as capture-settings-changed. */
public interface ManageDbCaptureUseCase {

    List<ProjectCaptureStatus> projects();

    /** @throws com.fathy.alfred.backend.dbcapture.domain.model.InboundLoggingOffException when switching on with inbound logging off */
    List<ProjectCaptureStatus> setEnabled(String project, boolean enabled);

    DbCaptureSettings settings(String project);

    /** @throws IllegalArgumentException when a value is out of range (400) */
    DbCaptureSettings saveSettings(String project, DbCaptureSettings settings);

    /** "Mark as expected" from a flag: that statement shape never raises a flag again for this project. */
    DbCaptureSettings markExpected(String project, String fingerprint);
}
