package com.fathy.alfred.backend.server.domain.model;

/** How a setting's value is written and validated (data-model "Validation rules by kind"). */
public enum SettingKind {
    BOOLEAN, INTEGER, SIZE_BYTES, MEMORY, PORT, HOST_PORT, PATH, ENUM, PROJECT_LIST, FOLDER_LIST, ACCESS_LIST, SECRET
}
