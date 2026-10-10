package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/** The acceptance items of one spec file. */
public record ChecklistFile(String fileName, List<ChecklistItem> items) {

    public ChecklistFile {
        items = List.copyOf(items);
    }
}
