package com.fathy.alfred.backend.teamboards.azure;

import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThatCode;

/** specs/038 G-3: what Alfred may send to Azure DevOps, and the one request that creates an item with everything. */
class AzureWriteGuardTest {

    private static final String ORG = "https://dev.azure.com/tilde";

    @Test
    void neverADeleteNorAWriteOutsideWorkItemsCommentsAndAttachments() {
        for (String[] refused : new String[][]{
                {"DELETE", ORG + "/Odeysys/_apis/wit/workitems/62565"},
                {"DELETE", ORG + "/Odeysys/_apis/wit/recyclebin/62565"},
                {"PATCH", ORG + "/Odeysys/_apis/wit/workitems/62565/comments/5"},
                {"PUT", ORG + "/Odeysys/_apis/wit/workitems/62565"},
                {"POST", ORG + "/_apis/projects"},
                {"PATCH", ORG + "/_apis/work/processes/abc/workitemtypes/Task"},
                {"POST", ORG + "/Odeysys/_apis/wit/classificationnodes/Areas"},
                {"POST", ORG + "/_apis/hooks/subscriptions"},
                {"POST", ORG + "/_apis/securitynamespaces/x"}}) {
            assertThatThrownBy(() -> AzureClient.allowed(refused[0], URI.create(refused[1]))).as(refused[0] + " " + refused[1])
                    .isInstanceOf(ProviderException.class).hasMessageContaining("never sends");
        }
        for (String[] ok : new String[][]{
                {"GET", ORG + "/_apis/projects"},
                {"POST", ORG + "/Odeysys/_apis/wit/workitems/$Task?api-version=7.1"},
                {"POST", ORG + "/Odeysys/_apis/wit/workitems/$User%20Story?validateOnly=true&api-version=7.1"},
                {"PATCH", ORG + "/_apis/wit/workitems/62565?api-version=7.1"},
                {"POST", ORG + "/Odeysys/_apis/wit/workItems/62565/comments?format=markdown"},
                {"POST", ORG + "/_apis/wit/attachments?fileName=x"},
                {"POST", ORG + "/Odeysys/_apis/wit/wiql"},
                {"POST", ORG + "/_apis/wit/workitemsbatch"},
                {"POST", "https://almsearch.dev.azure.com/tilde/_apis/search/workitemsearchresults"}}) {
            assertThatCode(() -> AzureClient.allowed(ok[0], URI.create(ok[1]))).as(ok[0] + " " + ok[1]).doesNotThrowAnyException();
        }
    }

    @Test
    void theConnectorSourceHasNoDeleteAtAll() throws IOException {
        Path dir = Path.of("src/main/java/com/fathy/alfred/backend/teamboards/azure");
        try (Stream<Path> files = Files.list(dir)) {
            for (Path f : files.toList()) {
                String text = Files.readString(f);
                assertThat(text).as(f.toString()).doesNotContain(".DELETE(").doesNotContain("\"DELETE\"").doesNotContain("recyclebin")
                        .doesNotContain("destroy");
            }
        }
    }

    @Test
    void aNewItemIsOneRequestWithEveryFieldItsParentLinksAndTags() {
        Connection c = new Connection("c1", "azure", "Tilde", URI.create(ORG), new Scope(List.of("Odeysys"), List.of()));
        NewItem item = new NewItem("Odeysys", "Task", "BE - Portal", "<p>Homepage list</p>", null, "Odeysys\\Sprint 1", "f.biomy@tildetech.ae",
                "62565", Map.of("Microsoft.VSTS.Common.Activity", "Development", "Microsoft.VSTS.Scheduling.OriginalEstimate", "16"),
                List.of(new Link("62555", "Related")), List.of("Back-end"));
        List<Map<String, Object>> ops = new AzureDevOpsConnector().createOps(c, item);
        assertThat(ops).extracting(o -> o.get("path")).contains("/fields/System.Title", "/fields/System.Description", "/fields/System.IterationPath",
                "/fields/System.AssignedTo", "/fields/Microsoft.VSTS.Common.Activity", "/fields/Microsoft.VSTS.Scheduling.OriginalEstimate",
                "/fields/System.Tags", "/relations/-");
        assertThat(ops.stream().filter(o -> "/relations/-".equals(o.get("path"))).map(o -> String.valueOf(((Map<?, ?>) o.get("value")).get("rel"))).toList())
                .containsExactly("System.LinkTypes.Hierarchy-Reverse", "System.LinkTypes.Related");
        assertThatThrownBy(() -> AzureDevOpsConnector.relName("Deletes")).isInstanceOf(IllegalArgumentException.class);
    }
}
