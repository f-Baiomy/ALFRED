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

    public static Opened open(ObjectMapper json, Path file) {
        SqliteBoardRepository repo = new SqliteBoardRepository(json, file.toString());
        repo.init();
        return new Opened(repo, repo::close);
    }
}
