package com.fathy.alfred.backend.server.domain.model;

/** The cards of the Settings tab's Server section (FR-020), in display order; also the section headers of .env. */
public enum SettingGroup {
    PROJECTS("Inbound projects"),
    NETWORK("Network"),
    STORAGE("Storage limits"),
    LOGS("Logs"),
    WILDFLY("WildFly"),
    SECRETS("Secrets");

    private final String title;

    SettingGroup(String title) {
        this.title = title;
    }

    public String title() {
        return title;
    }

    /** The comment line that starts this group's section in .env. */
    public String envHeader() {
        String head = "# --- " + title + " ";
        return head + "-".repeat(Math.max(3, 72 - head.length()));
    }
}
