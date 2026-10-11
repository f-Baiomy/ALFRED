package com.fathy.alfred.backend.board.domain.model;

import java.util.List;

/**
 * A team cards are assigned to (Settings → Teams). {@code owns} says, in plain words, what the team is responsible for -
 * Claude reads it to decide where a card belongs. {@code hints} are short texts (a path, a package, a supplier, a file
 * type) that, found in a card's title, description or mentions, suggest this team when a card is created without one.
 */
public record Team(String id, String name, String color, String icon, String owns, List<String> hints, int position) {

    public Team {
        name = name == null ? "" : name.strip();
        color = color == null || color.isBlank() ? "#8b8b93" : color.strip();
        icon = icon == null ? "" : icon.strip();
        owns = owns == null ? "" : owns.strip();
        hints = hints == null ? List.of() : hints.stream().filter(h -> h != null && !h.isBlank()).map(String::strip).toList();
    }
}
