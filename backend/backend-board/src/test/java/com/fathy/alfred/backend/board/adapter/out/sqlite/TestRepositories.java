package com.fathy.alfred.backend.board.adapter.out.sqlite;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;

import java.nio.file.Path;

/** Opens a SqliteBoardRepository at a path for tests outside this package (its file constructor is package-private). */
public final class TestRepositories {

    public record Opened(BoardStorePort store, AutoCloseable closer) {
    }

    private TestRepositories() {
    }

    /** Pages, state and shots in the same board.db as {@code store} (one opened by {@link #open}). */
    public static com.fathy.alfred.backend.board.application.port.out.SnippetStorePort snippets(BoardStorePort store) {
        SqliteSnippetRepository repo = new SqliteSnippetRepository((SqliteBoardRepository) store);
        repo.init();
        return repo;
    }

    /** The requirement check's tables in the same board.db as {@code store} (specs/018). */
    public static com.fathy.alfred.backend.board.application.port.out.RequirementStorePort requirements(BoardStorePort store, ObjectMapper json) {
        return new SqliteRequirementRepository((SqliteBoardRepository) store, json);
    }

    /** The board chats' tables in the same board.db as {@code store} (specs/022). */
    public static com.fathy.alfred.backend.board.application.port.out.ChatStorePort chats(BoardStorePort store, ObjectMapper json) {
        SqliteChatRepository repo = new SqliteChatRepository((SqliteBoardRepository) store, json);
        repo.init();
        return repo;
    }

    /** The brief comments' table in the same board.db as {@code store} (specs/024). */
    public static com.fathy.alfred.backend.board.application.port.out.BriefCommentStorePort briefComments(BoardStorePort store) {
        return new SqliteBriefCommentRepository((SqliteBoardRepository) store);
    }

    /** Boards, relations, homes and board activity in the same board.db as {@code store} (specs/027). */
    public static com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort boardModel(BoardStorePort store, ObjectMapper json) {
        return new SqliteBoardModelRepository((SqliteBoardRepository) store, json);
    }

    /** The questions forms' table in the same board.db as {@code store} (specs/037). */
    public static com.fathy.alfred.backend.board.application.port.out.QuestionFormStorePort questionForms(BoardStorePort store) {
        return new SqliteQuestionFormRepository((SqliteBoardRepository) store);
    }

    public static Opened open(ObjectMapper json, Path file) {
        SqliteBoardRepository repo = new SqliteBoardRepository(json, file.toString());
        repo.init();
        return new Opened(repo, repo::close);
    }
}
