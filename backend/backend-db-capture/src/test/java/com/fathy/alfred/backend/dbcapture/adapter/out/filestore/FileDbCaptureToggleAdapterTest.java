package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class FileDbCaptureToggleAdapterTest {

    @TempDir
    Path tempDir;

    private FileDbCaptureToggleAdapter adapterFor(Path file) throws Exception {
        FileDbCaptureToggleAdapter adapter = new FileDbCaptureToggleAdapter();
        Field field = FileDbCaptureToggleAdapter.class.getDeclaredField("toggleFile");
        field.setAccessible(true);
        field.set(adapter, file.toString());
        return adapter;
    }

    @Test
    void aMissingFileOrLineMeansOff() throws Exception {
        Path file = tempDir.resolve("db-capture-enabled.flag");
        FileDbCaptureToggleAdapter adapter = adapterFor(file);
        assertThat(adapter.isEnabled("wallet-app")).isFalse();
        Files.writeString(file, "other-app=on\n");
        assertThat(adapter.isEnabled("wallet-app")).isFalse();
        assertThat(adapter.isEnabled("other-app")).isTrue();
    }

    @Test
    void setEnabledKeepsOtherProjectsLines() throws Exception {
        Path file = tempDir.resolve("db-capture-enabled.flag");
        Files.writeString(file, "other-app=on\n");
        FileDbCaptureToggleAdapter adapter = adapterFor(file);
        adapter.setEnabled("wallet-app", true);
        adapter.setEnabled("other-app", false);
        assertThat(Files.readString(file)).isEqualTo("other-app=off\nwallet-app=on\n");
    }
}
