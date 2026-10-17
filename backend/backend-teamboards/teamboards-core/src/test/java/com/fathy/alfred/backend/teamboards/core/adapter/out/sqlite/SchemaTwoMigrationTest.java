package com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingSource;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** specs/028 T003/T004: a 027 file opens as schema 2 - the item cache gone, the notice set, connections and mappings kept. */
class SchemaTwoMigrationTest {

    @TempDir
    Path dir;

    @Test
    void a027FileLosesItsCacheAndKeepsItsSettings() throws Exception {
        Path file = dir.resolve("teamboards.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + file); Statement s = c.createStatement()) {
            s.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
            s.execute("CREATE TABLE connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, scope_json TEXT NOT NULL,"
                    + " fetched_at INTEGER, fetched_by TEXT, seen_at INTEGER, created_at INTEGER NOT NULL)");
            s.execute("INSERT INTO connections VALUES ('c1','azure','Acme','https://dev.azure.com/acme','{\"projects\":[],\"teams\":[]}',1,'x',1,1)");
            s.execute("CREATE TABLE items (conn TEXT, ext_id TEXT, title TEXT)");
            s.execute("INSERT INTO items VALUES ('c1','7','old')");
            s.execute("CREATE TABLE item_fields (conn TEXT, ext_id TEXT, k TEXT, v TEXT)");
            s.execute("CREATE TABLE revisions (conn TEXT, ext_id TEXT, rev INTEGER)");
            s.execute("CREATE TABLE changes (id INTEGER PRIMARY KEY)");
            s.execute("CREATE TABLE board_links (alfred_board TEXT PRIMARY KEY, conn TEXT, ext_id TEXT)");
            s.execute("CREATE TABLE mappings (id INTEGER PRIMARY KEY AUTOINCREMENT, conn TEXT NOT NULL, kind TEXT NOT NULL, ext_value TEXT NOT NULL,"
                    + " alfred_project TEXT NOT NULL, alfred_board TEXT, UNIQUE (conn, kind, ext_value))");
            s.execute("INSERT INTO mappings(conn, kind, ext_value, alfred_project) VALUES ('c1','SQUAD','Payments','odeysys')");
            s.execute("CREATE TABLE people (conn TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, PRIMARY KEY (conn, ext_id))");
            s.execute("INSERT INTO people VALUES ('c1','p1','Sara','sara@x')");
        }
        SqliteTeamCacheRepository repo = new SqliteTeamCacheRepository(file);
        try {
            for (String gone : SqliteTeamCacheRepository.DROPPED) {
                assertThat(repo.jdbc().queryForObject("SELECT COUNT(*) FROM sqlite_master WHERE name = ?", Integer.class, gone)).isZero();
            }
            assertThat(repo.upgradeNotice()).isTrue();
            assertThat(repo.connections()).singleElement().extracting(c -> c.name()).isEqualTo("Acme");
            assertThat(repo.mappings("c1")).hasSize(1);
            assertThat(repo.person("c1", "p1")).isPresent();
            repo.dismissUpgradeNotice();
            assertThat(repo.upgradeNotice()).isFalse();
        } finally {
            repo.close();
        }
        SqliteTeamCacheRepository again = new SqliteTeamCacheRepository(file);
        try {
            assertThat(again.upgradeNotice()).isFalse(); // once
        } finally {
            again.close();
        }
    }

    @Test
    void oneMainPerBoardAndIgnoredItemsReopenOnlyOnANewRev() {
        SqliteTeamCacheRepository repo = new SqliteTeamCacheRepository(dir.resolve("t.db"));
        try {
            Instant now = Instant.now();
            repo.putBoardItem(new BoardItemRow("b", "c", "1", "MAIN", "ROOT", null, null, 0, "Bug", "t", "New", "Proposed", 1, null, now, "user"));
            assertThatThrownBy(() -> repo.putBoardItem(new BoardItemRow("b", "c", "2", "MAIN", "ROOT", null, null, 0, "Bug", "t", "New", "Proposed", 1,
                    null, now, "user"))).isInstanceOf(RuntimeException.class);
            IncomingRow r = new IncomingRow("b", "c", "5", IncomingSource.RULE, now, 3, "Bug", "x", null, null, null, null, null, IncomingState.WAITING,
                    null);
            assertThat(repo.arrive(r)).isTrue();
            assertThat(repo.arrive(r)).isFalse();
            repo.putIncoming(new IncomingRow("b", "c", "5", IncomingSource.RULE, now, 3, "Bug", "x", null, null, null, null, null,
                    IncomingState.IGNORED, 3));
            assertThat(repo.arrive(r)).isFalse();
            assertThat(repo.arrive(new IncomingRow("b", "c", "5", IncomingSource.HOOK, now, 4, "Bug", "x", null, null, null, null, null,
                    IncomingState.WAITING, null))).isTrue();
            assertThat(repo.deleteBoard("b")).hasSize(1);
            assertThat(repo.boardItems("b")).isEmpty();
        } finally {
            repo.close();
        }
    }
}
