package com.fathy.alfred.backend.calls.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteCallLogAdapterTest {

    @TempDir
    Path tempDir;

    private final List<SqliteCallsRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteCallsRepository::close);
        // See SqliteCallsRepositoryTest's identical wait - avoids racing @TempDir's cleanup
        // against Windows releasing the SQLite file handle just after close() returns.
        Thread.sleep(50);
    }

    private SqliteCallsRepository repositoryFor(Path dbFile) throws Exception {
        SqliteCallsRepository repository = new SqliteCallsRepository();
        setField(repository, SqliteCallsRepository.class, "dbFile", dbFile.toString());
        setField(repository, SqliteCallsRepository.class, "maxSizeBytes", Long.MAX_VALUE);
        repository.init();
        opened.add(repository);
        return repository;
    }

    private SqliteCallLogAdapter adapterFor(SqliteCallsRepository repository, Path legacyFile) throws Exception {
        SqliteCallLogAdapter adapter = new SqliteCallLogAdapter(repository);
        setField(adapter, SqliteCallLogAdapter.class, "legacyFile", legacyFile.toString());
        return adapter;
    }

    private static void setField(Object target, Class<?> type, String name, Object value) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    void migratesEveryLineFromTheLegacyLogIntoSqliteAndRenamesTheFile() throws Exception {
        Path legacyFile = tempDir.resolve("RECENT_CALLS.log");
        Files.writeString(legacyFile, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                not valid json at all
                {"original_url":"https://b.com-proxy/x","url":"https://b.com/x","method":"POST","timestamp":"t2"}
                """);
        SqliteCallsRepository repository = repositoryFor(tempDir.resolve("calls.db"));
        SqliteCallLogAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        List<CallRecord> migrated = repository.readAll();
        assertThat(migrated).extracting(CallRecord::method).containsExactlyInAnyOrder("GET", "POST");
        assertThat(migrated).allSatisfy(call -> assertThat(call.id()).isNotBlank());
        assertThat(legacyFile).doesNotExist();
        assertThat(tempDir.resolve("RECENT_CALLS.log.migrated")).exists();
    }

    @Test
    void doesNothingWhenTheLegacyFileDoesNotExist() throws Exception {
        SqliteCallsRepository repository = repositoryFor(tempDir.resolve("calls.db"));
        SqliteCallLogAdapter adapter = adapterFor(repository, tempDir.resolve("missing.log"));

        adapter.migrateLegacyFileIfPresent();

        assertThat(repository.readAll()).isEmpty();
    }

    @Test
    void doesNotReMigrateOnceTheTableAlreadyHasRows() throws Exception {
        Path legacyFile = tempDir.resolve("RECENT_CALLS.log");
        Files.writeString(legacyFile, """
                {"original_url":"https://a.com-proxy/x","url":"https://a.com/x","method":"GET","timestamp":"t1"}
                """);
        SqliteCallsRepository repository = repositoryFor(tempDir.resolve("calls.db"));
        repository.save(new CallRecord("existing", "https://x.com/y", "https://x.com/y", "PUT", null, "t", 1.0, null, null));
        SqliteCallLogAdapter adapter = adapterFor(repository, legacyFile);

        adapter.migrateLegacyFileIfPresent();

        // The legacy file is left untouched (not migrated, not renamed) since the table already had data.
        assertThat(legacyFile).exists();
        assertThat(repository.readAll()).extracting(CallRecord::id).containsExactly("existing");
    }
}
