package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.domain.model.SettingsChange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** "alfred config" goes through the running backend when it answers, as the OS user, and keeps the API's verdicts. */
class HttpSettingsClientTest {

    @TempDir
    Path home;

    private HttpServer server;
    private String base;
    private final List<String> seen = new CopyOnWriteArrayList<>();

    /** Which install the fake backend claims to be: this test's home, or another folder. */
    private volatile String installDir;

    @BeforeEach
    void start() throws IOException {
        installDir = home.toString();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/health", x -> reply(x, 200, "{\"status\":\"UP\"}"));
        server.createContext("/server/status", x -> reply(x, 200,
                "{\"installDir\":" + (installDir == null ? "null" : "\"" + installDir.replace("\\", "\\\\") + "\"") + ",\"processes\":[]}"));
        server.createContext("/server/settings", x -> {
            seen.add(x.getRequestMethod() + " " + x.getRequestURI() + " user=" + x.getRequestHeaders().getFirst("X-Alfred-Cli-User"));
            if (x.getRequestMethod().equals("GET")) {
                reply(x, 200, """
                        {"envHash":"h1","settings":[{"key":"ALFRED_MEMORY","label":"Memory","kind":"MEMORY","applies":"RESTART",
                         "value":"2g","isSet":true,"source":"ENV_FILE","defaultValue":"2g","differsFromDefault":false}],
                         "missingFromEnv":[],"unknownLines":[{"line":3,"text":"FOO=1","reason":"unknown key, ignored"}]}""");
            } else {
                String body = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                if (body.contains("\"bad\"")) {
                    reply(x, 422, "{\"message\":\"Some values are not valid\",\"results\":[{\"key\":\"ALFRED_MEMORY\",\"level\":\"ERROR\",\"message\":\"not a size\"}]}");
                } else if (body.contains("\"stale\"")) {
                    reply(x, 409, "{\"message\":\".env was changed\"}");
                } else {
                    reply(x, 200, "{\"applied\":[{\"key\":\"ALFRED_MEMORY\",\"outcome\":\"PENDING_RESTART\"}]}");
                }
            }
        });
        server.start();
        base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private static void reply(com.sun.net.httpserver.HttpExchange x, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        x.getResponseHeaders().add("Content-Type", "application/json");
        x.sendResponseHeaders(status, bytes.length);
        x.getResponseBody().write(bytes);
        x.close();
    }

    private ServerConfigCli cli(java.io.ByteArrayOutputStream err) {
        return new ServerConfigCli(new java.io.PrintStream(new java.io.ByteArrayOutputStream()),
                new java.io.PrintStream(err, true, StandardCharsets.UTF_8));
    }

    @Test
    void theRunningBackendIsUsedWhenItAnswersAndTheFilesOtherwise() {
        java.io.ByteArrayOutputStream err = new java.io.ByteArrayOutputStream();
        assertThat(cli(err).client(new ServerConfigCli.Options(home, base, "ops")).where()).isEqualTo("live");
        assertThat(cli(err).client(new ServerConfigCli.Options(home, "http://127.0.0.1:1", "ops")).where()).isEqualTo("files");
        assertThat(cli(err).client(new ServerConfigCli.Options(home, null, "ops")).where()).isEqualTo("files");
        assertThat(err.toString(StandardCharsets.UTF_8)).isEmpty();
    }

    @Test
    void anotherAlfredAnsweringOnThePortIsNotThisInstall() {
        // The Docker install, or a second native one, answers /health the same way - a save must not land in ITS .env.
        installDir = home.resolveSibling("other-alfred").toString();
        java.io.ByteArrayOutputStream err = new java.io.ByteArrayOutputStream();
        assertThat(cli(err).client(new ServerConfigCli.Options(home, base, "ops")).where()).isEqualTo("files");
        assertThat(err.toString(StandardCharsets.UTF_8)).contains("another install").contains("other-alfred");

        // A backend that does not say where it lives (Docker mode) is not this install either.
        installDir = null;
        err.reset();
        assertThat(cli(err).client(new ServerConfigCli.Options(home, base, "ops")).where()).isEqualTo("files");
        assertThat(err.toString(StandardCharsets.UTF_8)).contains("not this install");
    }

    @Test
    void sameFolderIgnoresSpellingDifferencesOfOneFolder() throws IOException {
        assertThat(ServerConfigCli.sameFolder(home.toString(), home)).isTrue();
        assertThat(ServerConfigCli.sameFolder(home.resolve("app").resolve("..").toString(), home)).isTrue();
        assertThat(ServerConfigCli.sameFolder(home.resolveSibling("elsewhere").toString(), home)).isFalse();
        assertThat(ServerConfigCli.sameFolder("", home)).isFalse();
    }

    @Test
    void readsAndSavesAsTheOsUserAndKeepsTheVerdicts() {
        HttpSettingsClient client = new HttpSettingsClient(base, "ops");
        SettingsClient.View view = client.view();
        assertThat(view.envHash()).isEqualTo("h1");
        assertThat(view.settings()).singleElement().satisfies(s -> assertThat(s.value()).isEqualTo("2g"));
        assertThat(view.unusedLines()).containsExactly("line 3: \"FOO=1\" (unknown key, ignored)");

        assertThat(client.save("h1", List.of(SettingsChange.Edit.set("ALFRED_MEMORY", "3g"))))
                .singleElement().satisfies(a -> assertThat(a.outcome()).isEqualTo("PENDING_RESTART"));
        assertThat(seen).anySatisfy(s -> assertThat(s).isEqualTo("PUT /server/settings user=ops"));

        assertThatThrownBy(() -> client.save("h1", List.of(SettingsChange.Edit.set("ALFRED_MEMORY", "bad"))))
                .isInstanceOfSatisfying(SettingsClient.Refused.class, r -> {
                    assertThat(r.conflict).isFalse();
                    assertThat(r.results).singleElement().satisfies(v -> assertThat(v.message()).isEqualTo("not a size"));
                });
        assertThatThrownBy(() -> client.save("stale", List.of(SettingsChange.Edit.set("ALFRED_MEMORY", "3g"))))
                .isInstanceOfSatisfying(SettingsClient.Refused.class, r -> assertThat(r.conflict).isTrue());
    }
}
