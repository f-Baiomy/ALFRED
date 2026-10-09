package com.fathy.alfred.backend.server.adapter.out.update;

import com.fathy.alfred.backend.server.domain.model.UpdateManifest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class HttpUpdateFeedAdapterTest {

    @TempDir
    Path dir;

    private final HttpUpdateFeedAdapter adapter = new HttpUpdateFeedAdapter();

    static final String MANIFEST = """
            {"version":"1.5.0","notes":"Fixes","publishedAt":"2026-10-08T10:00:00Z",
             "assets":{"windows-x64":{"url":"https://example/alfred-setup-1.5.0-windows-x64.exe","sha256":"ab","size":145},
                       "linux-x64":{"url":"https://example/alfred-setup-1.5.0-linux-x64.run","sha256":"cd","size":241}}}""";

    @Test
    void readsAManifestFromAFileUrl_theOfflineAndTestCase() throws IOException {
        Path file = dir.resolve("latest.json");
        Files.writeString(file, MANIFEST);
        UpdateManifest manifest = adapter.fetch(file.toUri().toString());
        assertThat(manifest.version()).isEqualTo("1.5.0");
        assertThat(manifest.notes()).isEqualTo("Fixes");
        assertThat(manifest.asset("linux-x64")).hasValueSatisfying(a -> {
            assertThat(a.url()).endsWith("linux-x64.run");
            assertThat(a.sha256()).isEqualTo("cd");
            assertThat(a.size()).isEqualTo(241);
        });
        assertThat(manifest.asset("macos")).isEmpty();
    }

    @Test
    void readsTheRecentReleasesListedBeforeTheNewestOne() throws IOException {
        Path file = dir.resolve("latest.json");
        Files.writeString(file, """
                {"version": "1.5.0", "assets": {"linux-x64": {"url": "https://dl/1.5.0.run", "sha256": "a", "size": 3}},
                 "releases": [
                   {"version": "1.4.5", "notes": "fixes only", "publishedAt": "2026-10-05",
                    "assets": {"linux-x64": {"url": "https://dl/1.4.5.run", "sha256": "b", "size": 2}}},
                   {"notes": "no version: skipped"},
                   "not an object"
                 ]}
                """);
        UpdateManifest manifest = adapter.fetch(file.toUri().toString());
        assertThat(manifest.releases()).hasSize(1);
        assertThat(manifest.all()).extracting(UpdateManifest::version).containsExactly("1.5.0", "1.4.5");
        assertThat(manifest.releases().get(0).asset("linux-x64")).hasValueSatisfying(a -> assertThat(a.sha256()).isEqualTo("b"));
        assertThat(manifest.releases().get(0).notes()).isEqualTo("fixes only");
    }

    @Test
    void saysWhatIsWrongWithTheFeedInsteadOfAStackTrace() throws IOException {
        assertThatThrownBy(() -> adapter.fetch("")).isInstanceOf(IOException.class).hasMessageContaining("empty");
        assertThatThrownBy(() -> adapter.fetch("ftp://x/latest.json")).isInstanceOf(IOException.class).hasMessageContaining("http(s)");
        Path notJson = dir.resolve("a.json");
        Files.writeString(notJson, "<html>");
        assertThatThrownBy(() -> adapter.fetch(notJson.toUri().toString())).isInstanceOf(IOException.class).hasMessageContaining("not JSON");
        Path noVersion = dir.resolve("b.json");
        Files.writeString(noVersion, "{\"assets\":{}}");
        assertThatThrownBy(() -> adapter.fetch(noVersion.toUri().toString())).isInstanceOf(IOException.class).hasMessageContaining("no \"version\"");
        assertThatThrownBy(() -> adapter.fetch(dir.resolve("missing.json").toUri().toString())).isInstanceOf(IOException.class);
    }
}
