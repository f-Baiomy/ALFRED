package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.adapter.out.sqlite.SqliteTeamCacheRepository;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.LinkOutcome;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.LinkResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase.LinkView;
import com.fathy.alfred.backend.teamboards.core.application.port.in.SeedUseCase.Seed;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.CancelOutcome;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.StartOutcome;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.StartResult;
import com.fathy.alfred.backend.teamboards.core.application.port.in.StartFromItemUseCase.Target;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SeedTarget;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderWords;
import com.fathy.alfred.backend.teamboards.spi.SeedContributor;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemTypeInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.SeedPart;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.net.URI;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;

/** Start, the seed and board links on a real teamboards.db, a fake connector and fake boards (specs/027 US8/US9). */
class StartServiceTest {

    @TempDir
    Path dir;
    SqliteTeamCacheRepository cache;
    FakeBoards boards = new FakeBoards();
    StartService starts;
    LinksService links;
    SeedBuilder seeds;
    final Instant t0 = Instant.parse("2026-10-17T09:00:00Z");

    static class Fake implements Connector, AttachmentsReader, SeedContributor {
        int downloads;

        public String kind() { return "fake"; }

        public String displayName() { return "Fake DevOps"; }

        public ProviderWords words() { return ProviderWords.NEUTRAL; }

        public void changedItems(Connection c, Token t, Instant since, Consumer<List<Item>> page) { }

        public Item item(Connection c, Token t, String extId) { return null; }

        public List<ItemTypeInfo> types(Connection c, Token t) { return List.of(); }

        public List<Person> people(Connection c, Token t) { return List.of(); }

        public List<Attachment> attachments(Connection c, Token t, String extId, boolean withData) {
            downloads++;
            return List.of(new Attachment("trace.txt", "text/plain", 3, URI.create("https://x/a/1"), withData ? "abc".getBytes() : null),
                    new Attachment("huge.zip", "application/zip", 99_000_000L, URI.create("https://x/a/2"), null));
        }

        public List<Attachment> listedIn(Item item) {
            return List.of(new Attachment("trace.txt", "text/plain", 3, URI.create("https://x/a/1"), null));
        }

        public SeedPart seed(Item item) {
            return new SeedPart(null, null, null, "From the connector");
        }
    }

    static class FakeBoards implements TeamBoardsPort {
        final Map<String, String> projects = new HashMap<>(Map.of("b-refund", "odeysys", "b-other", "billing"));
        final List<String> posted = new ArrayList<>();
        final List<Long> withdrawn = new ArrayList<>();
        final Map<String, Set<String>> files = new HashMap<>();
        long next = 100;

        public Optional<String> projectOf(String boardId) { return Optional.ofNullable(projects.get(boardId)); }

        public Optional<Long> postStart(String project, String boardId, String text) {
            posted.add(project + "|" + boardId + "|" + text);
            return Optional.of(next++);
        }

        boolean taken;

        public boolean withdrawStart(long messageId) {
            if (taken) return false;
            withdrawn.add(messageId);
            return true;
        }

        public boolean askedBy(String askedIn) { return "terminal".equals(askedIn) || "41".equals(askedIn); }

        public Set<String> files(String boardId) { return files.getOrDefault(boardId, Set.of()); }

        public String attach(String boardId, String name, byte[] data) {
            files.computeIfAbsent(boardId, k -> new HashSet<>()).add(name);
            return null;
        }

        public boolean suggest(String project, String boardId, String conn, String extId, String text) { return false; }
    }

    Fake fake = new Fake();

    static Item item(String id, String type, String squad, int rev, Map<String, String> fields, List<Link> links) {
        return new Item(id, type, false, "Title " + id, "Active", "Sara", squad, "Odeysys\\Sprint 42", "Odeysys\\Payments",
                URI.create("https://dev.azure.example/x/_workitems/edit/" + id), rev, Instant.parse("2026-10-16T10:00:00Z"), "Sara", fields, links, "{}");
    }

    @BeforeEach
    void open() {
        cache = new SqliteTeamCacheRepository(dir.resolve("teamboards.db"));
        cache.putConnection(new StoredConnection("c1", "fake", "org", "https://dev.azure.example/org", new Scope(List.of(), List.of()), t0, "Sara", null, t0));
        StaticListableBeanFactory beans = new StaticListableBeanFactory();
        beans.addBean("boards", boards);
        starts = new StartService(List.of(fake), cache, (c, w) -> { }, beans.getBeanProvider(TeamBoardsPort.class), Clock.fixed(t0, ZoneOffset.UTC));
        links = new LinksService(List.of(fake), cache, (c, w) -> { }, beans.getBeanProvider(TeamBoardsPort.class));
        seeds = new SeedBuilder(List.of(fake), cache);
        cache.upsertItems("c1", List.of(
                item("7", "Bug", "Payments", 3, Map.of("System.Description", "Refund fails", "Microsoft.VSTS.TCM.ReproSteps", "1. pay 2. refund",
                        "Custom.Notes", "see logs"), List.of(new Link("5", "Parent"))),
                item("5", "Feature", "Payments", 1, Map.of("Microsoft.VSTS.Common.AcceptanceCriteria", "Refunds go to the card"),
                        List.of(new Link("7", "Child"), new Link("8", "Child"))),
                item("9", "Bug", null, 1, Map.of(), List.of())), t0);
    }

    @AfterEach
    void close() {
        cache.close();
    }

    @Test
    void theMappingIsFoundSprintFirstThenSquadThenAreaThenProject() {
        cache.putMapping("c1", MappingKind.PROJECT, "Odeysys", "p-project", null);
        assertThat(starts.targetOf("c1", "7").project()).isEqualTo("p-project");
        cache.putMapping("c1", MappingKind.AREA, "Odeysys\\Payments", "p-area", null);
        assertThat(starts.targetOf("c1", "7").project()).isEqualTo("p-area");
        cache.putMapping("c1", MappingKind.SQUAD, "Payments", "p-squad", null);
        assertThat(starts.targetOf("c1", "7").project()).isEqualTo("p-squad");
        cache.putMapping("c1", MappingKind.SPRINT, "Odeysys\\Sprint 42", "odeysys", "b-refund");
        assertThat(starts.targetOf("c1", "7")).isEqualTo(new Target("odeysys", "b-refund", false));
    }

    @Test
    void anUnmappedItemAsksWhereAndARememberedAnswerIsTheMappingNextTime() {
        assertThat(starts.start("c1", "9", null, null).outcome()).isEqualTo(StartOutcome.NEEDS_TARGET);
        assertThat(boards.posted).isEmpty();

        StartResult r = starts.start("c1", "9", new Target("odeysys", null, true), null);
        assertThat(r.outcome()).isEqualTo(StartOutcome.WAITING);
        assertThat(boards.posted).containsExactly("odeysys|null|/alfred-setup c1/9\nBug 9: Title 9");
        assertThat(cache.mappings("c1")).anyMatch(m -> m.kind() == MappingKind.AREA && m.alfredProject().equals("odeysys"));
        assertThat(starts.targetOf("c1", "9").project()).isEqualTo("odeysys");
    }

    @Test
    void oneStartPerItemAndCancelWithdrawsTheMessage() {
        cache.putMapping("c1", MappingKind.SQUAD, "Payments", "odeysys", "b-refund");
        StartResult first = starts.start("c1", "7", null, null);
        StartResult again = starts.start("c1", "7", null, null);
        assertThat(again.outcome()).isEqualTo(StartOutcome.WAITING);
        assertThat(again.messageId()).isEqualTo(first.messageId());
        assertThat(boards.posted).hasSize(1);

        boards.taken = true;
        assertThat(starts.cancel("c1", "7")).as("the setup has begun").isEqualTo(CancelOutcome.TAKEN);
        assertThat(starts.isWaiting("c1", "7")).isTrue();
        boards.taken = false;
        assertThat(starts.cancel("c1", "7")).isEqualTo(CancelOutcome.CANCELLED);
        assertThat(boards.withdrawn).containsExactly(first.messageId());
        assertThat(starts.cancel("c1", "7")).isEqualTo(CancelOutcome.NOT_WAITING);
        assertThat(starts.askedByUser("41")).isTrue();
        assertThat(starts.askedByUser("1")).isFalse();
    }

    @Test
    void aBoardOfAnotherProjectIsRefusedAndALinkedItemIsAlreadyStarted() {
        assertThat(starts.start("c1", "7", new Target("odeysys", "b-other", false), null).outcome()).isEqualTo(StartOutcome.INVALID);
        assertThat(links.link("b-refund", "c1", "7").outcome()).isEqualTo(LinkOutcome.OK);
        StartResult r = starts.start("c1", "7", new Target("odeysys", null, false), null);
        assertThat(r.outcome()).isEqualTo(StartOutcome.ALREADY_STARTED);
        assertThat(r.boardId()).isEqualTo("b-refund");
        assertThat(links.link("b-other", "c1", "7").outcome()).isEqualTo(LinkOutcome.ALREADY_LINKED);
    }

    @Test
    void withATokenTheAttachmentsWaitForTheBoardAndMoveOnLink() {
        StartResult r = starts.start("c1", "7", new Target("odeysys", "b-refund", false), new Token("pat"));
        assertThat(r.attachmentsFetched()).isEqualTo(1);
        LinkResult l = links.link("b-refund", "c1", "7");
        assertThat(l.attached()).containsExactly("trace.txt");
        assertThat(boards.files.get("b-refund")).containsExactly("trace.txt");
        assertThat(links.link("b-refund", "c1", "7").attached()).as("taken once").isEmpty();
        assertThat(cache.pending("c1", "7")).isEmpty();
    }

    @Test
    void withoutATokenNothingIsDownloadedAndTheBoardListsWhatItLacks() {
        starts.start("c1", "7", new Target("odeysys", "b-refund", false), null);
        assertThat(fake.downloads).isZero();
        links.link("b-refund", "c1", "7");
        LinkView v = links.linkOf("b-refund").orElseThrow();
        assertThat(v.attachments()).singleElement().satisfies(a -> {
            assertThat(a.name()).isEqualTo("trace.txt");
            assertThat(a.held()).isFalse();
        });
        assertThat(links.fetchAttachments("b-refund", null).outcome()).isEqualTo(LinkOutcome.TOKEN_MISSING);
        LinkResult fetched = links.fetchAttachments("b-refund", new Token("pat"));
        assertThat(fetched.attached()).containsExactly("trace.txt");
        assertThat(fetched.notAttached()).singleElement().asString().contains("huge.zip");
        assertThat(links.linkOf("b-refund").orElseThrow().attachments().get(0).held()).isTrue();
    }

    @Test
    void theSeedFollowsTheFieldMapsTheParentAndTheChildren() {
        cache.putFieldMap(new FieldMapRow("c1", "Bug", "Custom.Notes", SeedTarget.ACCEPTANCE));
        Seed s = seeds.seed("c1", "7").orElseThrow();
        assertThat(s.purpose()).isEqualTo("Refund fails");
        assertThat(s.steps()).isEqualTo("1. pay 2. refund");
        assertThat(s.acceptance()).isEqualTo("see logs");
        assertThat(s.context()).as("the connector's part fills an empty one").isEqualTo("From the connector");
        assertThat(s.parentAcceptance()).isEqualTo("Refunds go to the card");
        assertThat(s.provider()).isEqualTo("Fake DevOps");
        assertThat(s.attachments()).extracting(a -> a.name()).containsExactly("trace.txt");

        Seed feature = seeds.seed("c1", "5").orElseThrow();
        assertThat(feature.children()).containsExactly("7 · Bug · Title 7 · Active", "8 (not in the cache)");
    }

    @Test
    void changedSinceSetupIsTheSnapshotAgainstTheItemNowAndSeenResetsIt() {
        links.link("b-refund", "c1", "7");
        assertThat(links.linkOf("b-refund").orElseThrow().changedSinceSetup()).isEmpty();

        Map<String, String> f = new LinkedHashMap<>(Map.of("System.Description", "Refund fails for vouchers", "Microsoft.VSTS.TCM.ReproSteps",
                "1. pay 2. refund", "Custom.Notes", "see logs"));
        Item later = new Item("7", "Bug", false, "Title 7", "Resolved", "Sara", "Payments", "Odeysys\\Sprint 42", "Odeysys\\Payments",
                URI.create("https://dev.azure.example/x/_workitems/edit/7"), 4, Instant.parse("2026-10-17T08:00:00Z"), "Omar", f,
                List.of(new Link("5", "Parent")), "{}");
        cache.upsertItems("c1", List.of(later), t0);
        cache.putRevisions("c1", "7", List.of(new com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow(4, "Omar",
                Instant.parse("2026-10-17T08:00:00Z"), List.of(new com.fathy.alfred.backend.teamboards.spi.model.FieldChange("System.State", "Active", "Resolved")))));

        LinkView v = links.linkOf("b-refund").orElseThrow();
        assertThat(v.changedSinceSetup()).extracting(c -> c.field()).containsExactlyInAnyOrder("state", "System.Description");
        assertThat(v.changedSinceSetup()).filteredOn(c -> c.field().equals("state")).singleElement()
                .satisfies(c -> {
                    assertThat(c.from()).isEqualTo("Active");
                    assertThat(c.to()).isEqualTo("Resolved");
                    assertThat(c.by()).isEqualTo("Omar");
                });
        assertThat(links.seen("b-refund")).isTrue();
        assertThat(links.linkOf("b-refund").orElseThrow().changedSinceSetup()).isEmpty();

        assertThat(links.unlink("b-refund")).isTrue();
        assertThat(starts.start("c1", "7", new Target("odeysys", null, false), null).outcome()).as("Start again after the board went")
                .isEqualTo(StartOutcome.WAITING);
    }
}
