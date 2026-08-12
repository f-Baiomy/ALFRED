package com.fathy.alfred.backend.comments.adapter.out.sqlite;

import com.fathy.alfred.backend.comments.domain.model.Comment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteCommentsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private final List<SqliteCommentsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteCommentsRepository::close);
        Thread.sleep(50);
    }

    private SqliteCommentsRepository repositoryFor(Path dbFile) throws Exception {
        SqliteCommentsRepository repository = new SqliteCommentsRepository();
        setField(repository, SqliteCommentsRepository.class, "dbFile", dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private SqliteCommentsStoreAdapter adapterFor(SqliteCommentsRepository repository, Path legacyFile) throws Exception {
        SqliteCommentsStoreAdapter adapter = new SqliteCommentsStoreAdapter(repository);
        setField(adapter, SqliteCommentsStoreAdapter.class, "legacyFile", legacyFile.toString());
        return adapter;
    }

    private static void setField(Object target, Class<?> type, String name, Object value) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    void migratesEveryCommentFromTheLegacyFileAndRenamesIt() throws Exception {
        Path legacyFile = tempDir.resolve("comments.json");
        Files.writeString(legacyFile, """
                [{"id":"c1","callId":"call-1","block":"request-body","lineIndex":0,"lineText":"{","comment":"note","createdAt":"2026-01-01T00:00:00Z"}]
                """);
        SqliteCommentsRepository repository = repositoryFor(tempDir.resolve("comments.db"));
        SqliteCommentsStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.findAll()).extracting(Comment::id).containsExactly("c1");
        assertThat(legacyFile).doesNotExist();
        assertThat(tempDir.resolve("comments.json.migrated")).exists();
    }

    @Test
    void doesNothingWhenTheLegacyFileDoesNotExist() throws Exception {
        SqliteCommentsRepository repository = repositoryFor(tempDir.resolve("comments.db"));
        SqliteCommentsStoreAdapter adapter = adapterFor(repository, tempDir.resolve("missing.json"));

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.findAll()).isEmpty();
    }

    @Test
    void doesNotReMigrateOnceCommentsAlreadyExist() throws Exception {
        Path legacyFile = tempDir.resolve("comments.json");
        Files.writeString(legacyFile, """
                [{"id":"c1","callId":"call-1","block":"request-body","lineIndex":0,"lineText":"{","comment":"note","createdAt":"2026-01-01T00:00:00Z"}]
                """);
        SqliteCommentsRepository repository = repositoryFor(tempDir.resolve("comments.db"));
        repository.save(new Comment("existing", "call-2", "response-body", 1, "}", "already here", "t"));
        SqliteCommentsStoreAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        assertThat(legacyFile).exists();
        assertThat(repository.findAll()).extracting(Comment::id).containsExactly("existing");
    }
}
