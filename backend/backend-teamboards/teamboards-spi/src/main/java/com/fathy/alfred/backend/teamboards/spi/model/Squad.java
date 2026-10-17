package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/** A provider team (Azure "Team"): who is in it. */
public record Squad(String extId, String name, String project, List<String> memberIds) {

    public Squad {
        memberIds = memberIds == null ? List.of() : List.copyOf(memberIds);
    }
}
