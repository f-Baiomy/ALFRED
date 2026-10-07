package com.fathy.alfred.backend.server.adapter.out.envfile;

import com.fathy.alfred.backend.server.application.port.out.EnvConflictException;
import com.fathy.alfred.backend.server.domain.model.EnvDocument;
import com.fathy.alfred.backend.server.domain.model.SettingGroup;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class EnvFileAdapterTest {

    @TempDir
    Path dir;

    @Test
    void aMissingFileReadsAsEmptyAndIsCreatedOnWrite() throws Exception {
        EnvFileAdapter adapter = new EnvFileAdapter(dir.resolve(".env"));
        EnvDocument empty = adapter.read();
        assertThat(adapter.exists()).isFalse();

        adapter.write(empty.set("A", "1", SettingGroup.NETWORK.envHeader()), empty.contentHash());

        assertThat(Files.readString(dir.resolve(".env"))).contains("A=1");
        assertThat(dir.toFile().list()).containsExactly(".env");
    }

    @Test
    void aWriteIsRefusedWhenTheFileChangedUnderneath() throws Exception {
        Path file = dir.resolve(".env");
        Files.writeString(file, "A=1\n");
        EnvFileAdapter adapter = new EnvFileAdapter(file);
        EnvDocument loaded = adapter.read();

        Files.writeString(file, "A=2\n");

        assertThatThrownBy(() -> adapter.write(loaded.set("A", "3", "# --- x"), loaded.contentHash()))
                .isInstanceOf(EnvConflictException.class);
        assertThat(Files.readString(file)).isEqualTo("A=2\n");
    }

    @Test
    void ownerOnlyPermissionsAreKeptAndGivenToANewFile() throws Exception {
        assumeTrue(FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path file = dir.resolve(".env");
        EnvFileAdapter adapter = new EnvFileAdapter(file);
        adapter.write(EnvDocument.parse("A=1\n"), null);
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-------");

        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r-----"));
        adapter.write(adapter.read().set("A", "2", "# --- x"), adapter.read().contentHash());
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-r-----");
    }

    @Test
    void defaultsComeFromThePlaceholders() {
        assertThat(SettingsPropertiesDefaultsAdapter.parse(String.join("\n",
                "# comment",
                "reverse_proxy_enabled=${REVERSE_PROXY_ENABLED:false}",
                "internal_call_services=${INTERNAL_CALL_SERVICES:}",
                "wildfly_home=${WILDFLY_HOME}",
                "literal=abc")))
                .containsExactly(
                        org.assertj.core.api.Assertions.entry("REVERSE_PROXY_ENABLED", "false"),
                        org.assertj.core.api.Assertions.entry("INTERNAL_CALL_SERVICES", ""),
                        org.assertj.core.api.Assertions.entry("WILDFLY_HOME", ""));
    }

    @Test
    void theShippedSettingsPropertiesHasADefaultForEveryCatalogKey() {
        SettingsPropertiesDefaultsAdapter adapter = new SettingsPropertiesDefaultsAdapter(Path.of("..", "..", "settings.properties"));
        com.fathy.alfred.backend.server.domain.model.SettingCatalog.all().forEach(definition ->
                assertThat(adapter.defaults()).as(definition.key()).containsKey(definition.key()));
        assertThat(adapter.defaults()).containsEntry("REVERSE_PROXY_ENABLED", "false").containsEntry("INTERNAL_CALL_SERVICES", "")
                .containsEntry("ALFRED_CALLS_MAX_SIZE_BYTES", "10737418240");
    }
}
