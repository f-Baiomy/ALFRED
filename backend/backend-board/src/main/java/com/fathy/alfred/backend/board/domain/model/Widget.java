package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;

/**
 * A named, reusable visual of a project (specs/017 R34): a snippet (HTML, Mermaid, Python) or a fixed block (BLOCK -
 * board Markdown such as a ```chart fence), used in any text of the project as {@code {{widget:name | key=value}}}.
 * {@code {{key}}} in its source takes the value given where it is used; an HTML widget also reads them as alfred.vars.
 */
public record Widget(String project, String name, Kind kind, String info, String source, Actor author, Instant updatedAt, Actor updatedBy) {

    public enum Kind { HTML, MERMAID, PYTHON, BLOCK }

    public static final int MAX_SOURCE = 256 * 1024;
    public static final int MAX_PER_PROJECT = 100;
    public static final String NAME = "^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$";
}
