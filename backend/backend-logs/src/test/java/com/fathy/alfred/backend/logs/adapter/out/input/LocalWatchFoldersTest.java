package com.fathy.alfred.backend.logs.adapter.out.input;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Where a watched folder is read from: the Docker mount, or the host path itself in the native install. */
class LocalWatchFoldersTest {

    @TempDir
    Path host;
    @TempDir
    Path mounts;

    private LocalWatchFolders folders(String runtime, String dirs) {
        LocalWatchFolders folders = new LocalWatchFolders();
        ReflectionTestUtils.setField(folders, "watchDirs", dirs);
        ReflectionTestUtils.setField(folders, "watchRoot", mounts.toString());
        ReflectionTestUtils.setField(folders, "runtime", runtime);
        return folders;
    }

    @Test
    void theNativeInstallReadsTheHostFolderItself() throws Exception {
        Files.writeString(host.resolve("server.log"), "{\"msg\":\"x\"}\n");
        LocalWatchFolders folders = folders("native", "wildfly:" + host);

        assertThat(folders.dir("wildfly")).isEqualTo(host.toAbsolutePath().normalize().toString());
        assertThat(folders.folders()).singleElement().satisfies(f -> assertThat(f.toString()).contains("true"));
        assertThat(folders.files("wildfly", "*.log", false)).hasSize(1);
        assertThat(folders.match("wildfly", "../outside.log", "*", false)).isNull();
        assertThat(folders.match("unknown", "server.log", "*", false)).isNull();
    }

    @Test
    void dockerStillReadsTheMountUnderTheWatchRoot() throws Exception {
        Files.createDirectories(mounts.resolve("wildfly"));
        LocalWatchFolders folders = folders("docker", "wildfly:/opt/wildfly/standalone/log");

        assertThat(folders.dir("wildfly")).isEqualTo(mounts.resolve("wildfly").toAbsolutePath().normalize().toString());
    }

    @Test
    void aMissingNativeFolderSaysSoInsteadOfAskingForRestartPy() {
        LocalWatchFolders folders = folders("native", "gone:" + host.resolve("missing"));
        assertThatThrownBy(() -> folders.dir("gone")).hasMessageContaining("does not exist").hasMessageNotContaining("restart.py");
    }
}
