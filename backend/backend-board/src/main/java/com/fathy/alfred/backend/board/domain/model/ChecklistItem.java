package com.fathy.alfred.backend.board.domain.model;

/** One acceptance item of a spec file with its mark, if any, and the mark Claude suggests, if any. */
public record ChecklistItem(String key, String text, ChecklistMark mark, ChecklistSuggestion suggestion, java.util.List<CardRef> cards) {

    public ChecklistItem {
        cards = cards == null ? java.util.List.of() : java.util.List.copyOf(cards);
    }

    public ChecklistItem(String key, String text, ChecklistMark mark) {
        this(key, text, mark, null, null);
    }

    public ChecklistItem(String key, String text, ChecklistMark mark, ChecklistSuggestion suggestion) {
        this(key, text, mark, suggestion, null);
    }
}
