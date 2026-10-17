package com.fathy.alfred.backend.board.domain.model;

/**
 * Board ids (specs/027 research R1): a project's default board is {@code default:<project>}; a board migrated from a
 * session cycle keeps that cycle's id; any other board has a UUID. The project chat's stored key {@code ""} means the
 * default board (research R1 amendment), so existing chat rows need no rewrite.
 */
public final class BoardIds {

    public static final String DEFAULT_PREFIX = "default:";

    private BoardIds() {
    }

    public static String defaultOf(String project) {
        return DEFAULT_PREFIX + (project == null ? "" : project);
    }

    public static boolean isDefault(String boardId) {
        return boardId != null && boardId.startsWith(DEFAULT_PREFIX);
    }

    /** The project a default board id names; empty for other boards. */
    public static String projectOfDefault(String boardId) {
        return isDefault(boardId) ? boardId.substring(DEFAULT_PREFIX.length()) : "";
    }
}
