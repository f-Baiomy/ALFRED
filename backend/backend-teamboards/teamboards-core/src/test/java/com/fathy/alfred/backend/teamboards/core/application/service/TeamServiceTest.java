package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite.SqliteTeamCacheRepository;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase.NewConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase.Outcome;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ChangeRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectorInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshOutcome;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.SquadsReader;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Squad;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

/** The Team tab's service on a real teamboards.db and a fake connector (specs/027 US7, SC-007). */
class TeamServiceTest {

    static final String SECRET = "pat-0123456789abcdefSECRET";

    @TempDir
    Path dir;
    SqliteTeamCacheRepository cache;
    FakeConnector fake;
    TeamService team;
    List<String> signals = java.util.Collections.synchronizedList(new ArrayList<>());
    Instant now = Instant.parse("2026-10-17T09:00:00Z");

    /** A provider with whatever items the test puts in; it remembers the {@code since} it was asked for. */
    static class FakeConnector implements Connector, SquadsReader, com.fathy.alfred.backend.teamboards.spi.ItemIdsReader {
        /** What the tracker holds now; null: every item of {@code items}. */
        java.util.Set<String> present;
        final List<Item> items = new ArrayList<>();
        final List<Instant> asked = new ArrayList<>();
        ProviderException fail;
        String seenToken;

        @Override
        public String kind() {
            return "fake";
        }

        @Override
        public String displayName() {
            return "Fake";
        }

        @Override
        public ProviderWords words() {
            return new ProviderWords("Iteration", "Team", "Area Path", "Work item");
        }

        @Override
        public void changedItems(Connection c, Token t, Instant since, Consumer<List<Item>> page) throws ProviderException {
            seenToken = t.value();
            asked.add(since);
            if (fail != null) {
                throw fail;
            }
            List<Item> changed = items.stream().filter(i -> since == null || i.changedAt().isAfter(since)).toList();
            for (int i = 0; i < changed.size(); i += 2) {
                page.accept(changed.subList(i, Math.min(changed.size(), i + 2)));
            }
        }

        @Override
        public Item item(Connection c, Token t, String extId) {
            return items.stream().filter(i -> i.extId().equals(extId)).findFirst().orElseThrow();
        }

        @Override
        public List<ItemTypeInfo> types(Connection c, Token t) {
            return List.of(new ItemTypeInfo("Bug", false), new ItemTypeInfo("Meeting", true));
        }

        @Override
        public List<Person> people(Connection c, Token t) {
            return List.of(new Person("p1", "Sara", "sara@example.test"));
        }

        @Override
        public java.util.Set<String> allIds(Connection c, Token t) {
            if (present != null) {
                return present;
            }
            java.util.Set<String> out = new java.util.HashSet<>();
            items.forEach(i -> out.add(i.extId()));
            return out;
        }

        @Override
        public List<Squad> squads(Connection c, Token t) {
            return List.of(new Squad("t1", "Payments", "Odeysys", List.of("p1")));
        }
    }

    static Item item(String id, String type, String title, String state, int rev, Instant at) {
        return new Item(id, type, type.equals("Meeting"), title, state, "Sara", "Payments", "Sprint 42", "Odeysys\\Payments",
                URI.create("https://dev.azure.example/x/_workitems/edit/" + id), rev, at, "Sara",
                Map.of("System.Description", "<p>Refund to a voucher</p>"), List.of(), "{\"id\":" + id + "}");
    }

    @BeforeEach
    void open() {
        cache = new SqliteTeamCacheRepository(dir.resolve("teamboards.db"));
        fake = new FakeConnector();
        team = new TeamService(List.of(fake), cache, (conn, what) -> signals.add(conn + ":" + what), Clock.fixed(now, ZoneOffset.UTC));
    }

    @AfterEach
    void close() {
        cache.close();
    }

    private String connection() {
        return team.createConnection(new NewConnection("fake", "Odeysys org", "https://dev.azure.example/odeysys",
                new Scope(List.of("Odeysys"), List.of()))).value().id();
    }

    @Test
    void capabilitiesComeFromWhatTheConnectorImplementsAndUninstalledOnesAreListed() {
        assertThat(team.connectors()).extracting(ConnectorInfo::kind).containsExactly("fake", "azure", "clickup", "jira");
        ConnectorInfo f = team.connectors().get(0);
        assertThat(f.installed()).isTrue();
        assertThat(f.capabilities()).contains(Capability.SQUADS).doesNotContain(Capability.BOARDS, Capability.REVISIONS);
        assertThat(f.words()).containsEntry("sprint", "Iteration");
        assertThat(team.connectors()).filteredOn(c -> c.kind().equals("jira")).allMatch(c -> !c.installed());
    }

    @Test
    void aConnectionNeedsHttpsAndAnInstalledConnector() {
        assertThat(team.createConnection(new NewConnection("fake", "x", "http://dev.azure.example", null)).outcome()).isEqualTo(Outcome.INVALID);
        assertThat(team.createConnection(new NewConnection("fake", "x", "http://localhost:8099", null)).outcome()).isEqualTo(Outcome.OK);
        assertThat(team.createConnection(new NewConnection("jira", "x", "https://jira.example", null)).message()).contains("not installed");
    }

    @Test
    void refreshFetchesOnlyWhatChangedAndFeedsTheChanges() {
        String conn = connection();
        assertThat(team.refresh(conn, null, "me").outcome()).isEqualTo(RefreshOutcome.TOKEN_MISSING);

        fake.items.add(item("1", "Bug", "Refund rounds wrong", "Active", 3, now.minusSeconds(3600)));
        fake.items.add(item("2", "Meeting", "Sprint review", "New", 1, now.minusSeconds(1800)));
        fake.items.add(item("3", "Bug", "Lockout after 3", "Active", 1, now.minusSeconds(60)));
        var first = team.refresh(conn, new Token(SECRET), "Fathy");
        assertThat(first.outcome()).isEqualTo(RefreshOutcome.OK);
        assertThat(first.changed()).isEqualTo(3);
        assertThat(fake.asked).containsExactly((Instant) null);
        assertThat(team.items(new ItemQuery(conn, null, null, null, null, null, null, 0, 50)).total()).isEqualTo(3);
        assertThat(team.items(new ItemQuery(conn, "refu", null, null, null, null, null, 0, 50)).items())
                .extracting(i -> i.extId()).containsExactly("1");
        ConnectionRow row = team.connections().get(0);
        assertThat(row.fetchedBy()).isEqualTo("Fathy");
        assertThat(row.newChanges()).isEqualTo(3);
        assertThat(team.squads(conn).value()).singleElement().satisfies(s -> assertThat(s.members()).containsExactly("p1"));

        // the second refresh asks for what changed since the first, and a newer revision is a feed line saying what changed
        fake.items.set(0, item("1", "Bug", "Refund rounds wrong", "Resolved", 4, now.plusSeconds(10)));
        var second = team.refresh(conn, new Token(SECRET), "Fathy");
        assertThat(fake.asked.get(1)).isEqualTo(now);
        assertThat(second.changed()).isEqualTo(1);
        List<ChangeRow> feed = team.changes(conn, null, null, null, 10);
        assertThat(feed.get(0).summary()).isEqualTo("State Active → Resolved");
        assertThat(feed.get(0).fresh()).isTrue();

        // seen is shared: once anyone marks it, nobody sees those as new
        team.markSeen(conn);
        assertThat(team.connections().get(0).newChanges()).isZero();
        assertThat(signals).contains(conn + ":items", conn + ":changes");
    }

    @Test
    void providerFailuresBecomeOutcomes() {
        String conn = connection();
        fake.fail = new ProviderException(ProviderException.Kind.TOKEN_REJECTED, "no");
        assertThat(team.refresh(conn, new Token(SECRET), null).outcome()).isEqualTo(RefreshOutcome.TOKEN_REJECTED);
        fake.fail = new ProviderException(ProviderException.Kind.BUSY, "wait", 12);
        var busy = team.refresh(conn, new Token(SECRET), null);
        assertThat(busy.outcome()).isEqualTo(RefreshOutcome.PROVIDER_BUSY);
        assertThat(busy.retryAfter()).isEqualTo(12);
    }

    @Test
    void capabilitiesGateTheReads() {
        String conn = connection();
        assertThat(team.boards(conn).outcome()).isEqualTo(Outcome.NOT_SUPPORTED);
        assertThat(team.sprints(conn).outcome()).isEqualTo(Outcome.NOT_SUPPORTED);
        assertThat(team.squads(conn).outcome()).isEqualTo(Outcome.OK);
    }

    @Test
    void aSquadsAlfredMappingSurvivesTheNextRefresh() {
        String conn = connection();
        team.refresh(conn, new Token(SECRET), null);
        team.mapSquad(conn, "t1", "odeysys", "backend");
        team.refresh(conn, new Token(SECRET), null);
        assertThat(team.squads(conn).value().get(0).alfredTeam()).isEqualTo("backend");
    }

    @Test
    void theTokenIsNeverStored() throws Exception {
        String conn = connection();
        fake.items.add(item("1", "Bug", "Refund", "Active", 1, now.minusSeconds(60)));
        team.refresh(conn, new Token(SECRET), "Fathy");
        assertThat(fake.seenToken).isEqualTo(SECRET);
        cache.close();
        for (Path f : Files.list(dir).toList()) {
            assertThat(new String(Files.readAllBytes(f), StandardCharsets.ISO_8859_1)).as(f.toString()).doesNotContain(SECRET);
        }
        assertThat(new Token(SECRET).toString()).doesNotContain(SECRET);
    }

    @Test
    void anItemTheTrackerNoLongerHasLeavesTheCacheUnlessABoardLinksIt() {
        String conn = connection();
        fake.items.add(item("1", "Bug", "Kept", "Active", 1, now.minusSeconds(60)));
        fake.items.add(item("2", "Bug", "Deleted in Azure", "Active", 1, now.minusSeconds(60)));
        fake.items.add(item("3", "Bug", "Linked", "Active", 1, now.minusSeconds(60)));
        team.refresh(conn, new Token(SECRET), null);
        cache.putLink(new com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardLinkRow("b-1", conn, "3", "{}", 1));

        fake.present = java.util.Set.of();
        team.refresh(conn, new Token(SECRET), null);
        assertThat(team.items(new ItemQuery(conn, null, null, null, null, null, null, 0, 50)).total()).as("an empty answer removes nothing")
                .isEqualTo(3);

        fake.present = java.util.Set.of("1");
        var r = team.refresh(conn, new Token(SECRET), null);
        assertThat(r.changed()).isEqualTo(1);
        assertThat(team.items(new ItemQuery(conn, null, null, null, null, null, null, 0, 50)).items()).extracting(i -> i.extId())
                .containsExactlyInAnyOrder("1", "3");
        assertThat(team.changes(conn, null, null, null, 10).get(0).summary()).isEqualTo("removed from the tracker or its scope: Bug \"Deleted in Azure\"");
    }

    @Test
    void aBackgroundRefreshAnswersAtOnceAndSignalsItsOutcome() throws Exception {
        String conn = connection();
        assertThat(team.refreshInBackground(conn, null, null).outcome()).isEqualTo(RefreshOutcome.TOKEN_MISSING);
        fake.items.add(item("1", "Bug", "One", "Active", 1, now.minusSeconds(60)));
        assertThat(team.refreshInBackground(conn, new Token(SECRET), "Sara").outcome()).isEqualTo(RefreshOutcome.STARTED);
        for (int i = 0; i < 100 && !signals.contains(conn + ":refresh"); i++) {
            Thread.sleep(50);
        }
        assertThat(signals).contains(conn + ":refresh");
        assertThat(team.connections().get(0).fetchedBy()).isEqualTo("Sara");
    }
}
