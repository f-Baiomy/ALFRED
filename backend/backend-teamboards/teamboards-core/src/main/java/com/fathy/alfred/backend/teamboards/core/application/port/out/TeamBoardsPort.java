package com.fathy.alfred.backend.teamboards.core.application.port.out;

import java.util.Optional;
import java.util.Set;

/**
 * What the Team slice asks of Alfred's boards (specs/027 US8), implemented by backend-app/teamboardsbridge. Absent when
 * the bridge is not wired: then a start cannot be posted and the Team tab stays a read-only view.
 */
public interface TeamBoardsPort {

    /** The board's project, or empty when there is no such board. */
    Optional<String> projectOf(String boardId);

    /**
     * Posts the user's start as a waiting message in a board's chat ({@code boardId} null: the project's default board),
     * so the terminal holding it, or the project's runner, runs /alfred-setup. The message id, or empty when not posted.
     */
    Optional<Long> postStart(String project, String boardId, String text);

    /** Withdraws a waiting start's message (the user cancelled it before anyone took it). */
    void withdrawStart(long messageId);

    /** The names of the files a board already holds. */
    Set<String> files(String boardId);

    /** Attaches a file to a board as the user; null when stored, else why not (type, size, count). */
    String attach(String boardId, String name, byte[] data);

    /**
     * Claude's suggestion in a board's chat after a refresh brought a new item ({@code boardId} null: the project's
     * default board) - only when that chat has a live runner to act on the answer. True when posted.
     */
    boolean suggest(String project, String boardId, String conn, String extId, String text);
}
