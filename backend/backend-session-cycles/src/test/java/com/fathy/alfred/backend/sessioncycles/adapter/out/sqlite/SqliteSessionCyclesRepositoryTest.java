package com.fathy.alfred.backend.sessioncycles.adapter.out.sqlite;

import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.sessioncycles.domain.model.CapturedCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class SqliteSessionCyclesRepositoryTest {

    @TempDir
    Path tempDir;

    private final List<SqliteSessionCyclesRepository> opened = new ArrayList<>();

    @AfterEach
    void closeRepositories() throws InterruptedException {
        opened.forEach(SqliteSessionCyclesRepository::close);
        Thread.sleep(50);
    }

    private SqliteSessionCyclesRepository repositoryFor(Path dbFile) throws Exception {
        SqliteSessionCyclesRepository repository = new SqliteSessionCyclesRepository();
        Field field = SqliteSessionCyclesRepository.class.getDeclaredField("dbFile");
        field.setAccessible(true);
        field.set(repository, dbFile.toString());
        repository.init();
        opened.add(repository);
        return repository;
    }

    private static SessionCycle cycle(String id, SessionCycleStatus status) {
        return new SessionCycle(id, "Repro", "2026-01-01T00:00:00Z", "profile-1", status);
    }

    private static CallRecord call(String url, String timestamp) {
        return new CallRecord(UUID.randomUUID().toString(), url, url, "GET", null, timestamp, 1.0, null, null);
    }

    @Test
    void saveThenFindByIdRoundTripsACycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        SessionCycle cycle = cycle("c1", SessionCycleStatus.PAUSED);

        repo.saveCycle(cycle);

        Optional<SessionCycle> found = repo.findCycleById("c1");
        assertThat(found).contains(cycle);
    }

    @Test
    void saveUpsertsAnExistingCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.saveCycle(cycle("c1", SessionCycleStatus.PAUSED));

        repo.saveCycle(cycle("c1", SessionCycleStatus.RECORDING));

        assertThat(repo.findAllCycles()).hasSize(1);
        assertThat(repo.findCycleById("c1")).get().extracting(SessionCycle::status).isEqualTo(SessionCycleStatus.RECORDING);
    }

    @Test
    void deleteCycleByIdRemovesOnlyThatCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.saveCycle(cycle("c1", SessionCycleStatus.PAUSED));
        repo.saveCycle(cycle("c2", SessionCycleStatus.PAUSED));

        assertThat(repo.deleteCycleById("c1")).isTrue();

        assertThat(repo.findAllCycles()).extracting(SessionCycle::id).containsExactly("c2");
        assertThat(repo.deleteCycleById("missing")).isFalse();
    }

    @Test
    void appendThenFindAllByCycleRoundTripsACapturedCall() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = call("https://a.com/x", "t1");

        CapturedCall captured = repo.append("c1", call);

        assertThat(captured.id()).isNotBlank();
        List<CapturedCall> found = repo.findAllByCycle("c1");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).call().url()).isEqualTo("https://a.com/x");
    }

    @Test
    void findAllByCycleIsScopedToThatCycleOnly() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("https://a.com/x", "t1"));
        repo.append("c2", call("https://b.com/y", "t2"));

        assertThat(repo.findAllByCycle("c1")).extracting(c -> c.call().url()).containsExactly("https://a.com/x");
        assertThat(repo.findAllByCycle("c2")).extracting(c -> c.call().url()).containsExactly("https://b.com/y");
    }

    @Test
    void removeByIdRemovesOnlyTheMatchingCapturedCallInThatCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CapturedCall a = repo.append("c1", call("a", "t1"));
        CapturedCall b = repo.append("c1", call("b", "t2"));

        assertThat(repo.removeById("c1", a.id())).isTrue();

        assertThat(repo.findAllByCycle("c1")).extracting(CapturedCall::id).containsExactly(b.id());
        assertThat(repo.removeById("c1", "missing")).isFalse();
    }

    @Test
    void removeByIdsRemovesMultipleAndReturnsHowManyWereRemoved() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CapturedCall a = repo.append("c1", call("a", "t1"));
        CapturedCall b = repo.append("c1", call("b", "t2"));
        repo.append("c1", call("c", "t3"));

        int removed = repo.removeByIds("c1", List.of(a.id(), b.id(), "missing"));

        assertThat(removed).isEqualTo(2);
        assertThat(repo.findAllByCycle("c1")).extracting(c -> c.call().url()).containsExactly("c");
    }

    @Test
    void deleteAllForCycleRemovesEveryCapturedCallInThatCycleOnly() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("a", "t1"));
        repo.append("c2", call("b", "t2"));

        repo.deleteAllForCycle("c1");

        assertThat(repo.findAllByCycle("c1")).isEmpty();
        assertThat(repo.findAllByCycle("c2")).hasSize(1);
    }

    @Test
    void findByCallIdLooksUpByTheUnderlyingCallRecordId() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord call = call("https://a.com/x", "t1");
        CapturedCall captured = repo.append("c1", call);

        assertThat(repo.findByCallId("c1", call.id())).isPresent();
        assertThat(repo.findByCallId("c1", captured.id())).isEmpty();
    }

    @Test
    void queryFiltersSortsAndPaginatesScopedToOneCycle() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        repo.append("c1", call("https://a.com/x", "t1"));
        repo.append("c1", call("https://b.com/y", "t2"));
        repo.append("c2", call("https://c.com/z", "t3"));

        var page = repo.query("c1", "", "", "oldest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().url()).containsExactly("https://a.com/x", "https://b.com/y");
        assertThat(page.total()).isEqualTo(2);
    }

    @Test
    void querySearchMatchesInsideBodies() throws Exception {
        SqliteSessionCyclesRepository repo = repositoryFor(tempDir.resolve("session-cycles.db"));
        CallRecord withNeedle = new CallRecord(UUID.randomUUID().toString(), "https://a.com/x", "https://a.com/x", "GET",
                null, "t1", 1.0, new com.fathy.alfred.backend.calls.domain.model.ResponseData(200, null, "needle-here"), null);
        repo.append("c1", withNeedle);
        repo.append("c1", call("https://b.com/y", "t2"));

        var page = repo.query("c1", "needle-here", "", "newest", 0, 10, true);

        assertThat(page.items()).extracting(c -> c.call().id()).containsExactly(withNeedle.id());
    }
}
