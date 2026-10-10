package com.fathy.alfred.backend.board.domain.model;

/** One acceptance item of a spec file with its mark, if any, and the mark Claude suggests, if any. */
public record ChecklistItem(String key, String text, ChecklistMark mark, ChecklistSuggestion suggestion) {

    public ChecklistItem(String key, String text, ChecklistMark mark) {
        this(key, text, mark, null);
    }
}
