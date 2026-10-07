package com.fathy.alfred.backend.server.domain.model;

/** How a setting's value is written and validated (data-model "Validation rules by kind"). */
public enum SettingKind {
    BOOLEAN, INTEGER, SIZE_BYTES, MEMORY, PORT, HOST_PORT, PATH, ENUM, PROJECT_LIST, FOLDER_LIST, ACCESS_LIST, SECRET,
    /** An http(s) or file URL (the update feed). */
    URL,
    /** "HH:MM-HH:MM", may wrap midnight; blank means any time (the auto-update window). */
    TIME_WINDOW
}
