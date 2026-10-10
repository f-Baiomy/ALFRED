package com.fathy.alfred.backend.board.domain.model;

/** One acceptance item of a spec file with its mark, if any. */
public record ChecklistItem(String key, String text, ChecklistMark mark) {
}
