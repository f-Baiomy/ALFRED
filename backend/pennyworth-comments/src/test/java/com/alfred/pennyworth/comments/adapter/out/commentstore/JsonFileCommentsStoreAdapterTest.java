package com.alfred.pennyworth.comments.adapter.out.commentstore;

import com.alfred.pennyworth.comments.domain.model.Comment;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileCommentsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileCommentsStoreAdapter adapterFor(Path commentsFile) throws Exception {
        JsonFileCommentsStoreAdapter adapter = new JsonFileCommentsStoreAdapter();
        Field field = JsonFileCommentsStoreAdapter.class.getDeclaredField("commentsFile");
        field.setAccessible(true);
        field.set(adapter, commentsFile.toString());
        return adapter;
    }

    private static Comment comment(String id) {
        return new Comment(id, "call-1", "request-body", 0, "{", "note", "2026-01-01T00:00:00Z");
    }

    @Test
    void findAllReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileCommentsStoreAdapter adapter = adapterFor(tempDir.resolve("comments.json"));

        assertThat(adapter.findAll()).isEmpty();
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        JsonFileCommentsStoreAdapter adapter = adapterFor(tempDir.resolve("comments.json"));

        adapter.save(comment("c1"));
        adapter.save(comment("c2"));

        assertThat(adapter.findAll()).extracting(Comment::id).containsExactlyInAnyOrder("c1", "c2");
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("comments.json");
        adapterFor(file).save(comment("c1"));

        JsonFileCommentsStoreAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.findAll()).extracting(Comment::id).containsExactly("c1");
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingComment() throws Exception {
        JsonFileCommentsStoreAdapter adapter = adapterFor(tempDir.resolve("comments.json"));
        adapter.save(comment("c1"));
        adapter.save(comment("c2"));

        boolean removed = adapter.deleteById("c1");

        assertThat(removed).isTrue();
        assertThat(adapter.findAll()).extracting(Comment::id).containsExactly("c2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileCommentsStoreAdapter adapter = adapterFor(tempDir.resolve("comments.json"));
        adapter.save(comment("c1"));

        assertThat(adapter.deleteById("missing")).isFalse();
        assertThat(adapter.findAll()).hasSize(1);
    }

    @Test
    void createsMissingParentDirectoriesOnStartupCheck() throws Exception {
        Path nested = tempDir.resolve("nested/dir/comments.json");
        JsonFileCommentsStoreAdapter adapter = adapterFor(nested);

        adapter.checkStorageIsWritable();

        assertThat(nested.getParent()).exists();
        List<Comment> result = adapter.findAll();
        assertThat(result).isEmpty();
    }
}
