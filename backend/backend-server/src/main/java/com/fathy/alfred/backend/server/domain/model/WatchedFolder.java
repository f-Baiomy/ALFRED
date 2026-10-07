package com.fathy.alfred.backend.server.domain.model;

/** One entry of ALFRED_LOGS_WATCH_DIRS: a short name and a host folder whose log files are followed live. */
public record WatchedFolder(String name, String path) {

    public String serialize() {
        return name + ":" + path;
    }
}
