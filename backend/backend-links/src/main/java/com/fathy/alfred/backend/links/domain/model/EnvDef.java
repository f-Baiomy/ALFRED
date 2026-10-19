package com.fathy.alfred.backend.links.domain.model;

/**
 * An environment of a board (D35): named by the host, done on one Alfred. {@code linkId} null is the host itself - its
 * marks are the board's own. {@code required} environments must all pass for the board's Overall (D39).
 */
public record EnvDef(String boardId, String name, String linkId, boolean required, int ord) {
}
