package com.fathy.alfred.backend.teamboards.azure;

import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Mine;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import com.fathy.alfred.backend.teamboards.spi.model.TreeRef;
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
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Azure DevOps against recorded, scrubbed answers served on localhost (fake org, fake token, no real people). */
class AzureDevOpsConnectorTest {

    static final Token TOKEN = new Token("fake-pat-for-tests");

    HttpServer server;
    String base;
    final List<String> asked = new ArrayList<>();
    final List<String> bodies = new ArrayList<>();
    final List<String> types = new ArrayList<>();
    final AtomicInteger busyOnce = new AtomicInteger();
    String wiqlRefusal;
    boolean searchInstalled = true;
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
            String query = x.getRequestURI().getRawQuery() == null ? "" : x.getRequestURI().getRawQuery();
            String method = x.getRequestMethod();
            asked.add(method + " " + path + (query.contains("api-version=7.1-preview.4") ? " preview.4" : ""));
            String body = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            bodies.add(body);
            types.add(String.valueOf(x.getRequestHeaders().getFirst("Content-Type")));
            String auth = x.getRequestHeaders().getFirst("Authorization");
            String expected = "Basic " + Base64.getEncoder().encodeToString((":" + TOKEN.value()).getBytes(StandardCharsets.UTF_8));
            if (!expected.equals(auth)) {
                answer(x, 401, "");
                return;
            }
            if (path.endsWith("/_apis/wit/wiql")) {
                if (wiqlRefusal != null) {
                    answer(x, 400, wiqlRefusal);
                    return;
                }
                if (busyOnce.getAndDecrement() > 0) {
                    x.getResponseHeaders().add("Retry-After", "1");
                    answer(x, 429, "{}");
                    return;
                }
                if (body.contains("WorkItemLinks")) {
                    answer(x, 200, "{\"workItemRelations\":[{\"rel\":null,\"source\":null,\"target\":{\"id\":4521}},"
                            + "{\"rel\":\"System.LinkTypes.Hierarchy-Forward\",\"source\":{\"id\":4521},\"target\":{\"id\":4600}},"
                            + "{\"rel\":\"System.LinkTypes.Hierarchy-Forward\",\"source\":{\"id\":4600},\"target\":{\"id\":4601}}]}");
                    return;
                }
                answer(x, 200, "{\"workItems\":[{\"id\":4521},{\"id\":4522}]}");
            } else if (path.endsWith("/_apis/search/workitemsearchresults")) {
                if (!searchInstalled) {
                    answer(x, 404, "{}");
                    return;
                }
                answer(x, 200, "{\"count\":1,\"results\":[{\"fields\":{\"system.id\":\"4521\"}}]}");
            } else if (path.endsWith("/_apis/wit/workitemsbatch")) {
                answer(x, 200, fixture("workitemsbatch.json"));
            } else if (path.endsWith("/updates")) {
                answer(x, 200, fixture("updates.json"));
            } else if (path.endsWith("/comments")) {
                answer(x, 200, method.equals("POST") ? "{\"id\":77}" : "{\"comments\":[{\"id\":5,\"text\":\"Seen on prod\",\"createdBy\":{\"displayName\":"
                        + "\"Test User B\"},\"createdDate\":\"2026-10-12T08:00:00Z\"}]}");
            } else if (path.endsWith("/_apis/wit/workitems/4521") && method.equals("PATCH")) {
                answer(x, 200, "{\"id\":4521}");
            } else if (path.endsWith("/_apis/wit/workitems/4521")) {
                answer(x, 200, fixture("item-with-attachments.json").replace("@BASE@", base));
            } else if (path.contains("/_apis/wit/workitems/$")) {
                answer(x, 200, "{\"id\":4999}");
            } else if (path.endsWith("/_apis/wit/attachments") && method.equals("POST")) {
                answer(x, 200, "{\"id\":\"a1\",\"url\":\"" + base + "/_apis/wit/attachments/a1\"}");
            } else if (path.endsWith("/attachments/small")) {
                answer(x, 200, "hello");
            } else if (path.endsWith("/_apis/connectionData")) {
                answer(x, 200, "{\"authenticatedUser\":{\"id\":\"u-a\",\"providerDisplayName\":\"Test User A\","
                        + "\"properties\":{\"Account\":{\"$value\":\"a@example.test\"}}}}");
            } else if (path.endsWith("/_apis/identities")) {
                answer(x, 200, "{\"value\":[{\"id\":\"u-c\",\"providerDisplayName\":\"Test User C\",\"properties\":{\"Mail\":{\"$value\":\"c@example.test\"}}}]}");
            } else if (path.endsWith("/teamfieldvalues")) {
                answer(x, 200, "{\"values\":[{\"value\":\"Odeysys\\\\Payments\",\"includeChildren\":true}]}");
            } else if (path.endsWith("/_apis/wit/tags")) {
                answer(x, 200, "{\"value\":[{\"name\":\"uat\"},{\"name\":\"Refund\"},{\"name\":\"refund\"}]}");
            } else if (path.endsWith("/classificationnodes/Areas")) {
                answer(x, 200, "{\"path\":\"\\\\Odeysys\\\\Area\",\"children\":[{\"path\":\"\\\\Odeysys\\\\Area\\\\Payments\"}]}");
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

    static ItemQuery query(String text, boolean open, Set<Mine> mine, List<String> teams, List<String> iterations) {
        return new ItemQuery(text, List.of(), List.of(), open, List.of(), false, teams, iterations, List.of(), List.of(), null, List.of(), false,
                List.of(), mine, null, ItemQuery.Sort.CHANGED, 0, 50);
    }

    private String lastWiql() {
        for (int i = asked.size() - 1; i >= 0; i--) {
            if (asked.get(i).endsWith("/_apis/wit/wiql")) {
                return bodies.get(i);
            }
        }
        return "";
    }

    @Test
    void openOnlyLeavesOutWhateverTheProcessCallsClosedOrRemoved() throws Exception {
        ItemPage page = azure.search(connection, TOKEN, query(null, true, Set.of(), List.of(), List.of()));
        assertThat(page.fullText()).isFalse();
        assertThat(page.total()).isEqualTo(2);
        assertThat(lastWiql()).contains("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Won''t fix')").doesNotContain("'Resolved'")
                .contains("ORDER BY [System.ChangedDate] DESC");
    }

    @Test
    void textGoesToTheSearchApiAndFallsBackToWiqlWhenItIsNotInstalled() throws Exception {
        ItemPage page = azure.search(connection, TOKEN, query("voucher", false, Set.of(), List.of(), List.of()));
        assertThat(page.fullText()).isTrue();
        assertThat(page.items()).extracting(Item::extId).containsExactly("4521");
        searchInstalled = false;
        AzureDevOpsConnector other = new AzureDevOpsConnector(new AzureClient());
        ItemPage fallback = other.search(new Connection("c2", "azure", "x", URI.create(base), connection.scope()), TOKEN,
                query("vou'cher", false, Set.of(), List.of(), List.of()));
        assertThat(fallback.fullText()).isFalse();
        assertThat(lastWiql()).contains("[System.Title] CONTAINS 'vou''cher'");
    }

    @Test
    void mineTeamsAndCurrentIterationBecomeWiql() throws Exception {
        azure.search(connection, TOKEN, query(null, false, Set.of(Mine.ASSIGNED, Mine.CHANGED, Mine.MENTIONED, Mine.FOLLOWED),
                List.of("Odeysys\\Payments"), List.of("@current")));
        String w = lastWiql();
        assertThat(w).contains("[System.AssignedTo] = @Me").contains("[System.ChangedBy] EVER @Me").contains("@RecentMentions").contains("@Follows")
                .contains("[System.AreaPath] UNDER 'Odeysys\\\\Payments'").contains("@CurrentIteration('[Odeysys]\\\\Payments')");
        assertThat(asked).contains("POST /fake-org/Odeysys/Payments/_apis/wit/wiql");
    }

    /** specs/029: inside a filter the values are ORed, between filters ANDed; every value quoted. */
    @Test
    void everyFilterTakesSeveralValues() {
        ItemQuery q = new ItemQuery(null, List.of("Bug", "Task"), List.of("Active", "New"), false, List.of("Odeysys\\Refunds", "Odeysys\\PNR"), true,
                List.of(), List.of("@current", "Odeysys\\Sprint 59"), List.of("me", "o'neil@example.com", "none"), List.of("me", "sara@example.com"),
                null, List.of("refund", "uat"), true, List.of("59415", "#61200", "x"), Set.of(), null, ItemQuery.Sort.CHANGED, 0, 50);
        String w = AzureWiql.where(q, List.of(), Set.of(), java.util.Map.of(),
                List.of("@CurrentIteration('[Odeysys]\\Commandos')", "@CurrentIteration('[Odeysys]\\Uplogs')"));
        assertThat(w).contains("[System.WorkItemType] IN ('Bug', 'Task')").contains("[System.State] IN ('Active', 'New')")
                .contains("([System.AreaPath] = 'Odeysys\\Refunds' OR [System.AreaPath] = 'Odeysys\\PNR')")
                .contains("([System.IterationPath] = @CurrentIteration('[Odeysys]\\Commandos') OR [System.IterationPath] = @CurrentIteration('[Odeysys]\\Uplogs')"
                        + " OR [System.IterationPath] UNDER 'Odeysys\\Sprint 59')")
                .contains("([System.AssignedTo] IN (@Me, 'o''neil@example.com') OR [System.AssignedTo] = '')")
                .contains("[System.CreatedBy] IN (@Me, 'sara@example.com')")
                .contains("([System.Tags] CONTAINS 'refund' AND [System.Tags] CONTAINS 'uat')")
                .contains("[System.Parent] IN (59415, 61200)").doesNotContain("'x'");
        assertThat(AzureWiql.searchable(q)).isFalse();

        ItemQuery any = new ItemQuery("refund", List.of(), List.of(), false, List.of("Odeysys\\Refunds"), false, List.of(), List.of(),
                List.of("none"), List.of(), null, List.of("a", "b"), false, List.of("7"), Set.of(), null, ItemQuery.Sort.CHANGED, 0, 50);
        String w2 = AzureWiql.where(any, List.of(), Set.of(), java.util.Map.of(), List.of("@CurrentIteration"));
        assertThat(w2).contains("[System.AreaPath] UNDER 'Odeysys\\Refunds'").contains("[System.AssignedTo] = ''")
                .contains("([System.Tags] CONTAINS 'a' OR [System.Tags] CONTAINS 'b')").contains("[System.Parent] = 7");
        assertThat(AzureWiql.searchable(any)).isFalse(); // unassigned and sub-areas need WIQL
    }

    @Test
    void aRefusedRequestSaysWhichCallAndAzuresReason() {
        wiqlRefusal = "{\"$id\":\"1\",\"message\":\"TF51005: The query references a field\\n that does not exist.\",\"typeKey\":\"x\"}";
        assertThatThrownBy(() -> azure.query(connection, TOKEN, "SELECT [System.Id] FROM WorkItems", 10))
                .isInstanceOf(ProviderException.class)
                .hasMessage("Azure DevOps answered 400 to wiql: TF51005: The query references a field that does not exist.")
                .hasMessageNotContaining(TOKEN.value());
        wiqlRefusal = "{\"message\":\"VS402337: The number of work items returned exceeds the size limit of 20000.\"}";
        assertThatThrownBy(() -> azure.query(connection, TOKEN, "SELECT [System.Id] FROM WorkItems", 10)).hasMessageContaining("add a filter");
    }

    @Test
    void itemsComeFromTheBatchInNeutralTermsWithTheirPeople() throws Exception {
        List<Item> got = azure.items(connection, TOKEN, List.of("4522", "4521"));
        assertThat(got).extracting(Item::extId).containsExactly("4522", "4521");
        Item bug = got.get(1);
        assertThat(bug.type()).isEqualTo("Bug");
        assertThat(bug.assignee()).isEqualTo("Test User A");
        assertThat(bug.assignedPerson().extId()).isEqualTo("u-a");
        assertThat(bug.assignedPerson().email()).isEqualTo("a@example.test");
        assertThat(bug.project()).isEqualTo("Odeysys");
        assertThat(bug.squad()).isEqualTo("Payments");
        assertThat(bug.rev()).isEqualTo(7);
        assertThat(bug.fields()).containsEntry("Custom.Severity", "2").containsKey("Microsoft.VSTS.TCM.ReproSteps");
        assertThat(bug.links()).extracting(l -> l.kind() + ":" + l.toId()).contains("Parent:4400").anyMatch(s -> s.startsWith("PullRequest:"));
        assertThat(bug.url().toString()).endsWith("/Odeysys/_workitems/edit/4521");
        assertThat(got.get(0).customType()).as("Meeting is a custom type").isTrue();
    }

    @Test
    void commentsAreReadWithThePreviewApi() throws Exception {
        var comments = azure.comments(connection, TOKEN, "4521");
        assertThat(comments).singleElement().satisfies(c -> {
            assertThat(c.by()).isEqualTo("Test User B");
            assertThat(c.text()).isEqualTo("Seen on prod");
        });
        assertThat(asked).contains("GET /fake-org/Odeysys/_apis/wit/workItems/4521/comments preview.4");
    }

    @Test
    void theTreeHasDescendantsByDepthWithTheirParents() throws Exception {
        List<TreeRef> tree = azure.tree(connection, TOKEN, "4521", 200);
        assertThat(tree).extracting(t -> t.id() + ":" + t.relation() + ":" + t.depth()).containsExactly("4600:DESCENDANT:1",
                "4601:DESCENDANT:2");
        assertThat(tree.stream().filter(t -> t.id().equals("4601")).findFirst().orElseThrow().parent()).isEqualTo("4600");
    }

    @Test
    void whoAmIAndPeopleById() throws Exception {
        assertThat(azure.whoAmI(connection, TOKEN).name()).isEqualTo("Test User A");
        assertThat(azure.peopleById(connection, TOKEN, List.of("u-c"))).singleElement().satisfies(p -> {
            assertThat(p.name()).isEqualTo("Test User C");
            assertThat(p.email()).isEqualTo("c@example.test");
        });
    }

    @Test
    void statesAndAreasForTheLists() throws Exception {
        assertThat(azure.states(connection, TOKEN)).extracting(t -> t.type()).containsExactly("Bug", "Product Backlog Item");
        assertThat(azure.areas(connection, TOKEN)).containsExactly("Odeysys", "Odeysys\\Payments");
        assertThat(azure.tags(connection, TOKEN)).containsExactly("Refund", "uat");
        assertThat(AzureDevOpsConnector.areaPath("\\Odeysys\\Area\\Payments\\Refunds")).isEqualTo("Odeysys\\Payments\\Refunds");
    }

    @Test
    void writesAreJsonPatchAndCommentsAreMarkdown() throws Exception {
        azure.moveState(connection, TOKEN, "4521", "Resolved");
        int patch = asked.indexOf("PATCH /fake-org/_apis/wit/workitems/4521");
        assertThat(types.get(patch)).isEqualTo("application/json-patch+json");
        assertThat(bodies.get(patch)).contains("\"path\":\"/fields/System.State\"").contains("Resolved");
        azure.setField(connection, TOKEN, "4521", "Microsoft.VSTS.Common.Priority", "1");
        assertThat(bodies.get(bodies.size() - 1)).contains("\"path\":\"/fields/Microsoft.VSTS.Common.Priority\"").contains("\"value\":\"1\"");
        assertThat(azure.comment(connection, TOKEN, "4521", "Fixed **now**")).isEqualTo("77");
        assertThat(asked).contains("POST /fake-org/Odeysys/_apis/wit/workItems/4521/comments preview.4");
        assertThat(azure.create(connection, TOKEN, new NewItem("Odeysys", "Bug", "New bug", "line 1\nline <2>", null, null, null))).isEqualTo("4999");
        assertThat(bodies.get(bodies.size() - 1)).contains("<div>line 1<br>line &lt;2&gt;</div>").doesNotContain("relations");
        azure.create(connection, TOKEN, new NewItem("Odeysys", "Task", "Under the story", null, null, null, null, "61813"));
        assertThat(bodies.get(bodies.size() - 1)).contains("\"path\":\"/relations/-\"").contains("System.LinkTypes.Hierarchy-Reverse")
                .contains("/_apis/wit/workItems/61813");
        azure.attach(connection, TOKEN, "4521", "calls.html", "<html>".getBytes(StandardCharsets.UTF_8));
        assertThat(asked).contains("POST /fake-org/_apis/wit/attachments");
        assertThat(bodies.get(bodies.size() - 1)).contains("AttachedFile");
    }

    @Test
    void theHookBodyGivesItsItemIdOnly() {
        assertThat(azure.ids("{\"eventType\":\"workitem.updated\",\"resource\":{\"id\":3,\"workItemId\":4521,\"fields\":{}}}")).containsExactly("4521");
        assertThat(azure.ids("{\"eventType\":\"workitem.created\",\"resource\":{\"id\":4600}}")).containsExactly("4600");
        assertThat(azure.ids("not json")).isEmpty();
    }

    @Test
    void aBusyProviderIsRetriedOnceAfterRetryAfter() throws Exception {
        busyOnce.set(1);
        assertThat(azure.query(connection, TOKEN, "SELECT [System.Id] FROM WorkItems", 10)).hasSize(2);
        busyOnce.set(2);
        assertThatThrownBy(() -> azure.query(connection, TOKEN, "SELECT [System.Id] FROM WorkItems", 10))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.BUSY);
                    assertThat(e.retryAfterSeconds()).isEqualTo(1);
                });
    }

    @Test
    void aRefusedTokenIsTokenRejectedAndNeverInTheMessage() {
        Token bad = new Token("wrong-secret-token");
        assertThatThrownBy(() -> azure.items(connection, bad, List.of("4521")))
                .isInstanceOfSatisfying(ProviderException.class, e -> {
                    assertThat(e.kind()).isEqualTo(ProviderException.Kind.TOKEN_REJECTED);
                    assertThat(e.getMessage()).doesNotContain("wrong-secret-token");
                });
    }

    @Test
    void revisionsSayWhoChangedWhatAndSkipEmptyOnes() throws Exception {
        List<Revision> revs = azure.revisions(connection, TOKEN, "4521");
        assertThat(revs).hasSize(2);
        assertThat(revs.get(1).by()).isEqualTo("Test User A");
    }

    @Test
    void attachmentsWithinTheCapsAreDownloadedTheRestListed() throws Exception {
        List<Attachment> files = azure.attachments(connection, TOKEN, "4521", true);
        assertThat(files).extracting(Attachment::name).containsExactly("notes.txt", "video.mp4");
        assertThat(new String(files.get(0).data(), StandardCharsets.UTF_8)).isEqualTo("hello");
        assertThat(files.get(1).data()).as("over 10 MB: listed only").isNull();
        assertThat(azure.content(connection, TOKEN, files.get(0))).isEqualTo("hello".getBytes(StandardCharsets.UTF_8));
        assertThat(azure.content(connection, TOKEN, new Attachment("x", "text/plain", 1, URI.create("https://elsewhere.example/x"), null)))
                .as("the token never goes to another host").isNull();
    }

    @Test
    void squadsAreTheScopesTeamsWithTheirMembers() throws Exception {
        assertThat(azure.squads(connection, TOKEN)).singleElement().satisfies(s -> {
            assertThat(s.name()).isEqualTo("Payments");
            assertThat(s.memberIds()).containsExactly("u-a");
        });
    }

    @Test
    void otherAzureServicesOfTheSameOrganisation() {
        Connection cloud = new Connection("x", "azure", "x", URI.create("https://dev.azure.com/acme"), connection.scope());
        assertThat(AzureDevOpsConnector.service(cloud, "almsearch").toString()).isEqualTo("https://almsearch.dev.azure.com/acme");
        Connection old = new Connection("x", "azure", "x", URI.create("https://acme.visualstudio.com"), connection.scope());
        assertThat(AzureDevOpsConnector.service(old, "vssps").toString()).isEqualTo("https://acme.vssps.visualstudio.com");
    }
}
