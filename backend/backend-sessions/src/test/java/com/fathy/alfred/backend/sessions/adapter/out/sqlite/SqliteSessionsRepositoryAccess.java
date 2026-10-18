package com.fathy.alfred.backend.sessions.adapter.out.sqlite;

/** Opens the repository at a file for tests in other packages. */
public final class SqliteSessionsRepositoryAccess {

    private SqliteSessionsRepositoryAccess() {
    }

    public static SqliteSessionsRepository open(String file) {
        SqliteSessionsRepository repo = new SqliteSessionsRepository(file);
        repo.init();
        return repo;
    }
}
