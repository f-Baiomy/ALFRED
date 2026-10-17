package com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite;

import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** teamboards.db: lists without the raw item, search, the 20,000-item target, eviction order (specs/027 SC-005, Retention). */
class SqliteTeamCacheRepositoryTest {

    @TempDir
    Path dir;
    SqliteTeamCacheRepository repo;
    final Instant t0 = Instant.parse("2026-01-01T00:00:00Z");

    @BeforeEach
    void open() {
        repo = new SqliteTeamCacheRepository(dir.resolve("teamboards.db"));
        repo.putConnection(new StoredConnection("c1", "azure", "org", "https://dev.azure.example/org", new Scope(List.of(), List.of()), null, null,
                null, t0));
    }

    @AfterEach
    void close() {
        repo.close();
    }

    private Item item(int n) {
        return new Item(String.valueOf(n), n % 7 == 0 ? "Meeting" : "Bug", n % 7 == 0, "Item number " + n + (n % 100 == 0 ? " voucher" : ""),
                n % 2 == 0 ? "Active" : "New", "Sara", "Payments", "Sprint " + (n % 5), "Odeysys\\Payments", URI.create("https://x/" + n), 1,
                t0.plusSeconds(n), "Sara", Map.of("System.Description", "d" + n), List.of(), "{\"big\":\"" + "x".repeat(200) + "\"}");
    }

    @Test
    void listsAndSearchesTwentyThousandItemsQuickly() {
        List<Item> page = new ArrayList<>();
        for (int n = 1; n <= 20_000; n++) {
            page.add(item(n));
            if (page.size() == 500) {
                repo.upsertItems("c1", page, t0);
                page.clear();
            }
        }
        long start = System.nanoTime();
        var all = repo.items(new ItemQuery("c1", null, null, null, "Active", null, null, 0, 200));
        var found = repo.items(new ItemQuery("c1", "vouch", null, null, null, null, null, 0, 200));
        long ms = (System.nanoTime() - start) / 1_000_000;

        assertThat(all.total()).isEqualTo(10_000);
        assertThat(all.items()).hasSize(200);
        assertThat(all.items().get(0).extId()).isEqualTo("20000");
        assertThat(found.total()).isEqualTo(200);
        assertThat(ms).as("list + search ms").isLessThan(1000);
    }

    @Test
    void listQueriesNeverReadTheRawItem() {
        assertThat(SqliteTeamCacheRepository.SUMMARY).doesNotContain("native_json");
        repo.upsertItems("c1", List.of(item(1)), t0);
        assertThat(repo.nativeJson("c1", "1")).get().asString().contains("big");
    }

    @Test
    void evictionDropsOldChangesFirstAndNeverALinkedItem() {
        List<Item> page = new ArrayList<>();
        for (int n = 1; n <= 30; n++) {
            page.add(item(n));
        }
        repo.upsertItems("c1", page, t0);
        repo.putLink(new BoardLinkRow("b-1", "c1", "1", "{}", 1));
        for (int n = 0; n < 10; n++) {
            repo.addChange("c1", "1", n, "Sara", "Payments", t0.plusSeconds(n), "edited");
        }

        repo.evict(10, 1000, 4, t0.plusSeconds(3));

        assertThat(repo.changes("c1", null, null, null, 100)).hasSizeLessThanOrEqualTo(4)
                .allMatch(c -> !c.at().isBefore(t0.plusSeconds(3)));
        assertThat(repo.items(new ItemQuery("c1", null, null, null, null, null, null, 0, 200)).total()).isEqualTo(10);
        assertThat(repo.summary("c1", "1")).as("a linked item stays").isPresent();
    }

    @Test
    void deletingAConnectionTakesItsCacheWithIt() {
        repo.upsertItems("c1", List.of(item(1)), t0);
        assertThat(repo.deleteConnection("c1")).isTrue();
        assertThat(repo.summary("c1", "1")).isEmpty();
        assertThat(repo.items(new ItemQuery("c1", "Item", null, null, null, null, null, 0, 10)).total()).isZero();
    }

    @Test
    void aRefreshOnTheOldScopeDoesNotMarkAWidenedConnectionFetched() {
        Scope old = new Scope(List.of(), List.of());
        repo.markFetched("c1", t0, "Sara", old);
        assertThat(repo.connection("c1").orElseThrow().fetchedAt()).isEqualTo(t0);

        Scope wider = new Scope(List.of("Odeysys", "Billing"), List.of());
        repo.rescope("c1", "org", wider, true); // a new scope: everything is fetched again
        repo.markFetched("c1", t0.plusSeconds(60), "Omar", old); // the refresh that started before the change ends
        assertThat(repo.connection("c1").orElseThrow().fetchedAt()).as("still a full fetch next time").isNull();

        repo.markFetched("c1", t0.plusSeconds(120), "Omar", wider);
        assertThat(repo.connection("c1").orElseThrow().fetchedAt()).isEqualTo(t0.plusSeconds(120));
        assertThat(repo.connection("c1").orElseThrow().fetchedBy()).isEqualTo("Omar");
    }
}
