package com.fathy.alfred.backend.board.domain.model;

/**
 * Which chat (specs/022): a project's chat ({@code cycleId} empty) or one session cycle's chat. On the wire a chat is named
 * by its {@link #scope()} - {@code project} or the cycle id.
 */
public record ChatKey(String project, String cycleId) {

    public static final String PROJECT_SCOPE = "project";

    public ChatKey {
        project = project == null ? "" : project.strip();
        cycleId = cycleId == null ? "" : cycleId.strip();
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
