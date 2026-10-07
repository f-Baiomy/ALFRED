package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/** "alfred config" with Alfred stopped: the same settings service, on the files (contracts/cli.md). */
class ServerConfigCliSettingsTest {

    @TempDir
    Path home;

    private ByteArrayOutputStream out;
    private ByteArrayOutputStream err;

    @BeforeEach
    void install() throws Exception {
        Files.copy(Path.of("..", "..", "settings.properties"), home.resolve("settings.properties"));
        assertThat(run("", "init")).isZero();
    }

    private int run(String stdin, String... args) {
        out = new ByteArrayOutputStream();
        err = new ByteArrayOutputStream();
        String[] full = new String[args.length + 4];
        full[0] = "--home";
        full[1] = home.toString();
        full[2] = "--user";
        full[3] = "tester";
        System.arraycopy(args, 0, full, 4, args.length);
        return new ServerConfigCli(new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(err, true, StandardCharsets.UTF_8),
                new BufferedReader(new StringReader(stdin)), ServerConfigCli.Marks.ASCII).run(full);
    }

    private String out() {
        return out.toString(StandardCharsets.UTF_8);
    }

    private String env(String key) throws Exception {
        return EnvDocument.parse(Files.readString(home.resolve(".env"))).get(key).orElse(null);
    }

    @Test
    void listShowsEveryKeyWithItsSourceAndSecretsHaveNoValue() throws Exception {
        assertThat(run("", "list")).isZero();
        assertThat(out()).contains("KEY", "ALFRED_UI_PORT", "INTERNAL_CALL_SERVICES", "proxies restart")
                .contains("WEBHOOK_SECRET").contains("(set)")
                .doesNotContain(env("WEBHOOK_SECRET"));
        assertThat(run("", "get", "ALFRED_UI_PORT")).isZero();
        assertThat(out().strip()).isEqualTo("3000");
    }

    @Test
    void setWritesEnvAndSaysItTakesEffectAtStart() throws Exception {
        assertThat(run("", "set", "INTERNAL_CALLS_RETENTION_ROWS", "3000")).isZero();
        assertThat(env("INTERNAL_CALLS_RETENTION_ROWS")).isEqualTo("3000");
        assertThat(out()).contains("ok .env: INTERNAL_CALLS_RETENTION_ROWS 1500 -> 3000").contains("not running");

        assertThat(run("", "diff")).isZero();
        assertThat(out()).contains("INTERNAL_CALLS_RETENTION_ROWS").doesNotContain("ALFRED_UI_PORT");
    }

    @Test
    void anInvalidValueIsRefusedWithExitThreeAndNothingWritten() throws Exception {
        String before = Files.readString(home.resolve(".env"));
        assertThat(run("", "set", "ALFRED_UI_PORT", "70000")).isEqualTo(ServerConfigCli.REFUSED);
        assertThat(err.toString(StandardCharsets.UTF_8)).contains("error ALFRED_UI_PORT").contains("Nothing saved");
        assertThat(Files.readString(home.resolve(".env"))).isEqualTo(before);

        assertThat(run("", "set", "NOT_A_KEY", "1")).isEqualTo(ServerConfigCli.ERROR);
    }

    @Test
    void resetRemovesTheLineSoTheDefaultApplies() throws Exception {
        run("", "set", "ALFRED_MEMORY", "3g");
        assertThat(run("", "reset", "ALFRED_MEMORY")).isZero();
        assertThat(env("ALFRED_MEMORY")).isNull();
        assertThat(out()).contains("(default)");
    }

    @Test
    void projectsAndFoldersAreAddedAndRemovedByName() throws Exception {
        assertThat(run("", "project-add", "demo", "9001", "8080")).isZero();
        assertThat(run("", "project-add", "core", "9002", "8083", "--outbound", "core.local:8443")).isZero();
        assertThat(env("INTERNAL_CALL_SERVICES")).isEqualTo("demo:9001:8080,core:9002:8083:core.local:8443");

        assertThat(run("", "project-add", "demo", "9003", "8080")).isEqualTo(ServerConfigCli.ERROR);
        assertThat(run("", "project-remove", "demo")).isZero();
        assertThat(env("INTERNAL_CALL_SERVICES")).isEqualTo("core:9002:8083:core.local:8443");
        assertThat(run("", "remove", "INTERNAL_CALL_SERVICES", "nope")).isEqualTo(ServerConfigCli.ERROR);

        Path logs = Files.createDirectories(home.resolve("app-logs"));
        assertThat(run("", "add", "ALFRED_LOGS_WATCH_DIRS", "app:" + logs)).isZero();
        assertThat(env("ALFRED_LOGS_WATCH_DIRS")).isEqualTo("app:" + logs);
        assertThat(run("", "remove", "ALFRED_LOGS_WATCH_DIRS", "app")).isZero();
        assertThat(env("ALFRED_LOGS_WATCH_DIRS")).isEmpty();

        assertThat(run("", "add", "ALFRED_MEMORY", "x")).isEqualTo(ServerConfigCli.ERROR);
    }

    @Test
    void historyRecordsCliChangesAndRevertPutsTheOldValueBack() throws Exception {
        run("", "set", "INTERNAL_CALLS_RETENTION_ROWS", "4000");
        assertThat(run("", "history")).isZero();
        assertThat(out()).contains("CLI tester").contains("INTERNAL_CALLS_RETENTION_ROWS 1500 -> 4000");
        String id = out().lines().filter(l -> l.contains("CLI tester")).findFirst().orElseThrow().substring(1).split(" ")[0];

        assertThat(run("n\n", "revert", id)).isZero();
        assertThat(env("INTERNAL_CALLS_RETENTION_ROWS")).isEqualTo("4000");
        assertThat(run("y\n", "revert", id)).isZero();
        assertThat(env("INTERNAL_CALLS_RETENTION_ROWS")).isEqualTo("1500");
    }

    @Test
    void importAsksPerValueAndSkipsWhatIsNotASetting() throws Exception {
        Path file = home.resolve("other.env");
        Files.writeString(file, "ALFRED_MEMORY=3g\nINTERNAL_CALLS_RETENTION_ROWS=2500\nALFRED_UI_PORT=99999\nFOO=1\n");
        assertThat(run("y\nn\n", "import", file.toString())).isZero();
        assertThat(env("ALFRED_MEMORY")).isEqualTo("3g");
        assertThat(env("INTERNAL_CALLS_RETENTION_ROWS")).isEqualTo("1500");
        assertThat(env("ALFRED_UI_PORT")).isEqualTo("3000");
        assertThat(out()).contains("not taken: the value is not valid").contains("skipped: FOO");
    }

    @Test
    void addMissingWritesRemovedKeysAndCheckReportsEveryKey() throws Exception {
        String text = Files.readString(home.resolve(".env")).replaceAll("(?m)^ALFRED_MEMORY=.*\\n", "");
        Files.writeString(home.resolve(".env"), text);
        assertThat(run("", "list")).isZero();
        assertThat(out()).contains("1 not in .env");
        assertThat(run("", "add-missing")).isZero();
        assertThat(env("ALFRED_MEMORY")).isNotNull();

        assertThat(run("", "check")).isIn(ServerConfigCli.OK, ServerConfigCli.REFUSED);
        assertThat(out()).contains("ALFRED_MEMORY");
    }
}
