package com.fathy.alfred.backend.teamboards.azure;

import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Azure DevOps against recorded, scrubbed answers served on localhost (fake org, fake token, no real people). */
class AzureDevOpsConnectorTest {

    static final Token TOKEN = new Token("fake-pat-for-tests");

    HttpServer server;
    String base;
    final List<String> asked = new ArrayList<>();
    final AtomicInteger busyOnce = new AtomicInteger();
    String wiqlRefusal;
    /** Refuse (VS402337) every WIQL query whose window is longer than this, as Azure does past 20,000 matches. */
    java.time.Duration tooManyOver;
    final List<String> queries = new ArrayList<>();
    AzureDevOpsConnector azure;
    Connection connection;

    private static String fixture(String name) throws IOException {
        try (InputStream in = AzureDevOpsConnectorTest.class.getResourceAsStream("/azure/" + name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private void answer(HttpExchange x, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("Content-Type", "application/json");
        x.sendResponseHeaders(status, bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            x.getResponseBody().write(bytes);
        }
        x.close();
    }

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        base = "http://127.0.0.1:" + server.getAddress().getPort() + "/fake-org";
        server.createContext("/", x -> {
            String path = x.getRequestURI().getPath();
            asked.add(x.getRequestMethod() + " " + path);
            String auth = x.getRequestHeaders().getFirst("Authorization");
            String expected = "Basic " + Base64.getEncoder().encodeToString((":" + TOKEN.value()).getBytes(StandardCharsets.UTF_8));
            if (!expected.equals(auth)) {
                answer(x, 401, "");
                return;
            }
            if (path.endsWith("/_apis/wit/wiql")) {
                String query = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                queries.add(query);
                if (tooManyOver != null) {
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("'(\\d{4}-[^']+)'").matcher(query);
                    List<java.time.Instant> at = new ArrayList<>();
                    while (m.find()) {
                        at.add(java.time.Instant.parse(m.group(1)));
                    }
                    if (at.size() == 2 && java.time.Duration.between(at.get(0), at.get(1)).compareTo(tooManyOver) > 0) {
                        answer(x, 400, "{\"message\":\"VS402337: The number of work items returned exceeds the size limit of 20000.\"}");
                        return;
                    }
                }
                if (wiqlRefusal != null) {
                    answer(x, 400, wiqlRefusal);
                    return;
                }
                if (busyOnce.getAndDecrement() > 0) {
                    x.getResponseHeaders().add("Retry-After", "1");
                    answer(x, 429, "{}");
                    return;
                }
                answer(x, 200, "{\"workItems\":[{\"id\":4521},{\"id\":4522}]}");
            } else if (path.endsWith("/_apis/wit/workitemsbatch")) {
                answer(x, 200, fixture("workitemsbatch.json"));
            } else if (path.endsWith("/updates")) {
                answer(x, 200, fixture("updates.json"));
            } else if (path.endsWith("/_apis/wit/workitems/4521")) {
                answer(x, 200, fixture("item-with-attachments.json").replace("@BASE@", base));
            } else if (path.endsWith("/attachments/small")) {
                answer(x, 200, "hello");
            } else if (path.endsWith("/_apis/wit/workitemtypes")) {
                answer(x, 200, "{\"value\":[{\"name\":\"Bug\",\"states\":[{\"name\":\"New\",\"category\":\"Proposed\"},"
                        + "{\"name\":\"Active\",\"category\":\"InProgress\"},{\"name\":\"Resolved\",\"category\":\"Resolved\"},"
                        + "{\"name\":\"Closed\",\"category\":\"Completed\"},{\"name\":\"Removed\",\"category\":\"Removed\"}]},"
                        + "{\"name\":\"Product Backlog Item\",\"states\":[{\"name\":\"Done\",\"category\":\"Completed\"},"
                        + "{\"name\":\"Won't fix\",\"category\":\"Removed\"}]}]}");
            } else if (path.endsWith("/teams")) {
                answer(x, 200, "{\"value\":[{\"id\":\"t1\",\"name\":\"Payments\"},{\"id\":\"t2\",\"name\":\"Other\"}]}");
            } else if (path.endsWith("/members")) {
                answer(x, 200, "{\"value\":[{\"identity\":{\"id\":\"u-a\",\"displayName\":\"Test User A\",\"uniqueName\":\"a@example.test\"}}]}");
            } else {
                answer(x, 404, "{}");
            }
        });
        server.start();
        AzureClient client = new AzureClient();
        client.sleeper = ms -> { };
        azure = new AzureDevOpsConnector(client);
        connection = new Connection("c1", "azure", "Fake org", URI.create(base), new Scope(List.of("Odeysys"), List.of("Payments")));
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void onlyItemsNotClosedOrRemovedAreFetchedWhateverTheProcessCallsThoseStates() throws Exception {
        azure.changedItems(connection, TOKEN, null, page -> { });
        assertThat(queries).hasSize(1);
        assertThat(queries.get(0)).contains("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Won''t fix')")
                .doesNotContain("'Resolved'").doesNotContain("'Active'");
        queries.clear();
        azure.allIds(connection, TOKEN);
        assertThat(queries.get(0)).as("an item closed since leaves the cache").contains("NOT IN ('Closed'");
    }

    @Test
    void aWindowAzureFindsTooBigIsSplitInHalvesUntilEachAnswers() throws Exception {
        tooManyOver = java.time.Duration.ofDays(3650);
        List<Item> got = new ArrayList<>();
        azure.changedItems(connection, TOKEN, null, got::addAll);

        assertThat(queries).allMatch(q -> q.contains("[System.ChangedDate] >= '") && q.contains("[System.ChangedDate] < '"));
        assertThat(queries.get(0)).as("a first fetch starts before any item").contains(">= '2000-01-01T00:00:00Z'");
        int answered = got.size() / 2; // each window that answers holds the fake's two items
        assertThat(answered).as("the 26-year window halves down to windows of at most ten years").isBetween(3, 4);
        assertThat(queries.size() - answered).as("the windows Azure refused").isPositive();

        queries.clear();
        tooManyOver = null;
        assertThat(azure.allIds(connection, TOKEN)).containsExactlyInAnyOrder("4521", "4522");
        assertThat(queries).hasSize(1);
    }

    @Test
    void aWindowOfOneSecondStillRefusedIsTheError() {
        tooManyOver = java.time.Duration.ZERO;
        assertThatThrownBy(() -> azure.changedItems(connection, TOKEN, java.time.Instant.now().plusSeconds(3598), page -> { }))
                .hasMessageContaining("VS402337");
    }

    @Test
    void aRefusedRequestSaysWhichCallAndAzuresReason() {
        wiqlRefusal = "{\"$id\":\"1\",\"message\":\"TF51005: The query references a field\\n that does not exist.\",\"typeKey\":\"x\"}";
        assertThatThrownBy(() -> azure.changedItems(connection, TOKEN, null, page -> { }))
                .isInstanceOf(ProviderException.class)
                .hasMessage("Azure DevOps answered 400 to wiql: TF51005: The query references a field that does not exist.")
                .hasMessageNotContaining(TOKEN.value());
        wiqlRefusal = "not json";
        assertThatThrownBy(() -> azure.changedItems(connection, TOKEN, null, page -> { })).hasMessage("Azure DevOps answered 400 to wiql");
    }

    @Test
    void changedItemsComeFromWiqlThenTheBatchInNeutralTerms() throws Exception {
        List<Item> got = new ArrayList<>();
        azure.changedItems(connection, TOKEN, null, got::addAll);

        assertThat(got).hasSize(2);
        Item bug = got.get(0);
        assertThat(bug.extId()).isEqualTo("4521");
        assertThat(bug.type()).isEqualTo("Bug");
        assertThat(bug.customType()).isFalse();
        assertThat(bug.assignee()).isEqualTo("Test User A");
        assertThat(bug.changedBy()).isEqualTo("Test User B");
        assertThat(bug.squad()).isEqualTo("Payments");
        assertThat(bug.sprint()).isEqualTo("Odeysys\\Sprint 42");
        assertThat(bug.rev()).isEqualTo(7);
        assertThat(bug.fields()).containsEntry("Custom.Severity", "2").containsKey("Microsoft.VSTS.TCM.ReproSteps");
        assertThat(bug.links()).extracting(l -> l.kind() + ":" + l.toId()).contains("Parent:4400").anyMatch(s -> s.startsWith("PullRequest:"));
        assertThat(bug.links()).noneMatch(l -> l.toId().contains("attachments"));
        assertThat(bug.url().toString()).endsWith("/Odeysys/_workitems/edit/4521");
        assertThat(got.get(1).customType()).as("Meeting is a custom type").isTrue();
        assertThat(asked).contains("POST /fake-org/Odeysys/_apis/wit/wiql", "POST /fake-org/_apis/wit/workitemsbatch");
    }

    @Test
    void aBusyProviderIsRetriedOnceAfterRetryAfter() throws Exception {
        busyOnce.set(1);
        List<Item> got = new ArrayList<>();
        azure.changedItems(connection, TOKEN, null, got::addAll);
        assertThat(got).hasSize(2);

        busyOnce.set(2);
        assertThatThrownBy(() -> azure.changedItems(connection, TOKEN, null, p -> { }))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.BUSY);
                    assertThat(e.retryAfterSeconds()).isEqualTo(1);
                });
    }

    @Test
    void aRefusedTokenIsTokenRejectedAndNeverInTheMessage() {
        Token bad = new Token("wrong-secret-token");
        assertThatThrownBy(() -> azure.changedItems(connection, bad, null, p -> { }))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.TOKEN_REJECTED);
                    assertThat(e.getMessage()).doesNotContain("wrong-secret-token");
                });
    }

    @Test
    void revisionsSayWhoChangedWhatAndSkipEmptyOnes() throws Exception {
        List<Revision> revs = azure.revisions(connection, TOKEN, "4521");
        assertThat(revs).hasSize(2);
        Revision second = revs.get(1);
        assertThat(second.by()).isEqualTo("Test User A");
        assertThat(second.at()).isEqualTo(java.time.Instant.parse("2026-10-12T08:00:00Z"));
        assertThat(second.changes()).anySatisfy(c -> {
            assertThat(c.field()).isEqualTo("System.AssignedTo");
            assertThat(c.from()).isEqualTo("Test User B");
            assertThat(c.to()).isEqualTo("Test User A");
        });
    }

    @Test
    void attachmentsWithinTheCapsAreDownloadedTheRestListed() throws Exception {
        List<Attachment> files = azure.attachments(connection, TOKEN, "4521", true);
        assertThat(files).extracting(Attachment::name).containsExactly("notes.txt", "video.mp4");
        assertThat(new String(files.get(0).data(), StandardCharsets.UTF_8)).isEqualTo("hello");
        assertThat(files.get(1).data()).as("over 10 MB: listed only").isNull();
        assertThat(asked).noneMatch(a -> a.endsWith("/huge"));
    }

    @Test
    void squadsAreTheScopesTeamsWithTheirMembers() throws Exception {
        var squads = azure.squads(connection, TOKEN);
        assertThat(squads).singleElement().satisfies(s -> {
            assertThat(s.name()).isEqualTo("Payments");
            assertThat(s.memberIds()).containsExactly("u-a");
        });
        assertThat(azure.people(connection, TOKEN)).extracting(p -> p.name()).containsExactly("Test User A");
    }
}
