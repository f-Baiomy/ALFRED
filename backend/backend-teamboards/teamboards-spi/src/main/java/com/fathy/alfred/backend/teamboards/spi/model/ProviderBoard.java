package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;

/** A provider board (Azure "Backlog board") with its columns. */
public record ProviderBoard(String extId, String name, String project, String team, List<String> columns) {

    public ProviderBoard {
        columns = columns == null ? List.of() : List.copyOf(columns);
    }
}
