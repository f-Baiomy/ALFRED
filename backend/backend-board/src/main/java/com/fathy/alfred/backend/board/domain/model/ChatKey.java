package com.fathy.alfred.backend.board.domain.model;

/**
 * Which chat (specs/022): a project's chat ({@code cycleId} empty) or one session cycle's chat. On the wire a chat is named
 * by its {@link #scope()} - {@code project} or the cycle id. Since specs/027 a chat belongs to a board: {@code cycleId} is
 * the board id (equal to the old cycle id for a migrated board), and the project chat is the default board's chat - its
 * id {@code default:<project>} is stored as {@code ""}.
 */
public record ChatKey(String project, String cycleId) {

    public static final String PROJECT_SCOPE = "project";

    public ChatKey {
        project = project == null ? "" : project.strip();
        cycleId = cycleId == null ? "" : cycleId.strip();
        // The default board's chat is the old project chat, stored under "" (specs/027 research R1 amendment).
        if (cycleId.equals(BoardIds.defaultOf(project))) {
            cycleId = "";
        }
    }

    /** {@code scope} as the API gives it: "project" or a cycle id. */
    public static ChatKey of(String project, String scope) {
        return new ChatKey(project, scope == null || PROJECT_SCOPE.equals(scope) ? "" : scope);
    }

    public boolean isProject() {
        return cycleId.isEmpty();
    }

    public String scope() {
        return isProject() ? PROJECT_SCOPE : cycleId;
    }
}
