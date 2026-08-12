package com.fathy.alfred.backend.comments.adapter.out.sqlite;

import com.fathy.alfred.backend.comments.domain.model.Comment;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteCommentsRepositoryTest {

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
        Field field = SqliteCommentsRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static Comment comment(String id) {
        return new Comment(id, "call-1", "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        SqliteCommentsRepository repo = repositoryFor(tempDir.resolve("comments.db"));

        repo.save(comment("c1"));
        repo.save(comment("c2"));

        assertThat(repo.findAll()).extracting(Comment::id).containsExactlyInAnyOrder("c1", "c2");
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingComment() throws Exception {
        SqliteCommentsRepository repo = repositoryFor(tempDir.resolve("comments.db"));
        repo.save(comment("c1"));
        repo.save(comment("c2"));

        boolean removed = repo.deleteById("c1");

        assertThat(removed).isTrue();
        assertThat(repo.findAll()).extracting(Comment::id).containsExactly("c2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        SqliteCommentsRepository repo = repositoryFor(tempDir.resolve("comments.db"));
        repo.save(comment("c1"));

        assertThat(repo.deleteById("missing")).isFalse();
        assertThat(repo.findAll()).hasSize(1);
    }

    @Test
    void replaceAllOverwritesEveryComment() throws Exception {
        SqliteCommentsRepository repo = repositoryFor(tempDir.resolve("comments.db"));
        repo.save(comment("c1"));
        repo.save(comment("c2"));

        Comment migrated = new Comment("c1", "new-call-id", "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
        repo.replaceAll(List.of(migrated));

        assertThat(repo.findAll()).containsExactly(migrated);
    }
}
