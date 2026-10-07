package com.fathy.alfred.backend.server.cli;

import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.SettingCatalog;
import com.fathy.alfred.backend.server.domain.model.SettingGroup;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class ServerConfigCliInitTest {

    @TempDir
    Path home;
    @TempDir
    Path docker;

    private final ByteArrayOutputStream out = new ByteArrayOutputStream();

    @BeforeEach
    void defaults() throws Exception {
        Files.copy(Path.of("..", "..", "settings.properties"), home.resolve("settings.properties"));
    }

    private int run(String... args) {
        String[] full = new String[args.length + 2];
        full[0] = "--home";
        full[1] = home.toString();
        System.arraycopy(args, 0, full, 2, args.length);
        return new ServerConfigCli(new PrintStream(out, true, StandardCharsets.UTF_8), new PrintStream(new ByteArrayOutputStream())).run(full);
    }

    @Test
    void initWritesEveryKeyOnceUnderItsGroupWithAGeneratedSecret() throws Exception {
        assertThat(run("init")).isZero();
        String text = Files.readString(home.resolve(".env"));
        EnvDocument doc = EnvDocument.parse(text);

        SettingCatalog.all().forEach(d -> assertThat(doc.get(d.key())).as(d.key()).isPresent());
        assertThat(doc.entries()).hasSize(SettingCatalog.all().size());
        for (SettingGroup group : SettingGroup.values()) {
            assertThat(text).contains(group.envHeader());
        }
        assertThat(doc.get("REVERSE_PROXY_ENABLED")).contains("false");
        assertThat(doc.get("ALFRED_CALLS_MAX_SIZE_BYTES")).contains("10737418240");
        assertThat(doc.get("WEBHOOK_SECRET")).hasValueSatisfying(secret -> assertThat(secret).hasSize(64).isNotEqualTo("change-me-in-production"));
        assertThat(doc.unknownLines()).isEmpty();
    }

    @Test
    void initLeavesAnExistingFileAlone() throws Exception {
        Files.writeString(home.resolve(".env"), "A=1\n");
        assertThat(run("init")).isZero();
        assertThat(Files.readString(home.resolve(".env"))).isEqualTo("A=1\n");
    }

    @Test
    void mergeDockerEnvCopiesSettingsDropsDockerOnlyKeysAndMakesPathsAbsolute() throws Exception {
        Files.writeString(docker.resolve(".env"), String.join("\n",
                "BACKEND_PORT=5000",
                "COMPOSE_PROFILES=inbound-logging",
                "REVERSE_PROXY_ENABLED=true",
                "INTERNAL_CALL_SERVICES=odeysys:9001:8080",
                "FORWARD_PROXY_PORT_MAP=",
                "ALFRED_LOGS_DIR=./logs-drop",
                "ALFRED_LOGS_WATCH_DIRS=wildfly:/opt/wildfly/standalone/log,rel:logs/here",
                "ALFRED_LOGS_WATCH_MODE_RESOLVED=agent",
                "SOMETHING_ELSE=1", ""));

        assertThat(run("merge-docker-env", docker.toString())).isZero();

        EnvDocument doc = EnvDocument.parse(Files.readString(home.resolve(".env")));
        assertThat(doc.get("REVERSE_PROXY_ENABLED")).contains("true");
        assertThat(doc.get("INTERNAL_CALL_SERVICES")).contains("odeysys:9001:8080");
        assertThat(doc.get("ALFRED_LOGS_DIR")).contains(docker.resolve("logs-drop").normalize().toString());
        assertThat(doc.get("ALFRED_LOGS_WATCH_DIRS"))
                .contains("wildfly:/opt/wildfly/standalone/log,rel:" + docker.resolve("logs/here").normalize());
        assertThat(doc.entries()).doesNotContainKeys("BACKEND_PORT", "COMPOSE_PROFILES", "FORWARD_PROXY_PORT_MAP",
                "ALFRED_LOGS_WATCH_MODE_RESOLVED", "SOMETHING_ELSE");
        assertThat(out.toString(StandardCharsets.UTF_8)).contains("Skipped").contains("BACKEND_PORT").contains("SOMETHING_ELSE");
    }

    @Test
    void checkEnvReportsLineNumbers() throws Exception {
        Files.writeString(home.resolve(".env"), "REVERSE_PROXY_ENABLED=true\nALFRED_CALLS_MAX_SIZE=2GB\nnot a line\nBACKEND_PORT=5000\n");
        assertThat(run("check-env")).isZero();
        assertThat(out.toString(StandardCharsets.UTF_8))
                .contains("line 2: \"ALFRED_CALLS_MAX_SIZE=2GB\" (unknown key, ignored)")
                .contains("line 3: \"not a line\" (not KEY=value)")
                .contains("line 4: \"BACKEND_PORT=5000\" (only used by the Docker install, ignored here)");
    }
}
