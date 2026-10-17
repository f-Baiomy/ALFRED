package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/** What a connection reads: the provider's projects and teams (empty = everything the token can read). At most 50 / 200. */
public record Scope(List<String> projects, List<String> teams) {

    public static final int MAX_PROJECTS = 50;
    public static final int MAX_TEAMS = 200;

    public Scope {
        projects = projects == null ? List.of() : List.copyOf(projects);
        teams = teams == null ? List.of() : List.copyOf(teams);
    }
}
