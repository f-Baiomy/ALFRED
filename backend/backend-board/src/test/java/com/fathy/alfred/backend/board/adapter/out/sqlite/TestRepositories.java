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

    public static Opened open(ObjectMapper json, Path file) {
        SqliteBoardRepository repo = new SqliteBoardRepository(json, file.toString());
        repo.init();
        return new Opened(repo, repo::close);
    }
}
