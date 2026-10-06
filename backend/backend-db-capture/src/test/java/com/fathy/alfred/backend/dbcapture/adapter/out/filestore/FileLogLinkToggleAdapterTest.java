package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class FileLogLinkToggleAdapterTest {

    @TempDir
    Path tempDir;

    private FileLogLinkToggleAdapter adapterFor(Path file) throws Exception {
        FileLogLinkToggleAdapter adapter = new FileLogLinkToggleAdapter();
        Field field = FileLogLinkToggleAdapter.class.getDeclaredField("toggleFile");
        field.setAccessible(true);
        field.set(adapter, file.toString());
        return adapter;
    }

    @Test
    void aMissingFileOrLineMeansOff_andSwitchingKeepsOtherProjects() throws Exception {
        Path file = tempDir.resolve("log-link-enabled.flag");
        FileLogLinkToggleAdapter adapter = adapterFor(file);
        assertThat(adapter.isOn("odeysys")).isFalse();
        Files.writeString(file, "core-service=on\n");
        assertThat(adapter.isOn("odeysys")).isFalse();
        adapter.setOn("odeysys", true);
        adapter.setOn("core-service", false);
        assertThat(Files.readString(file)).isEqualTo("core-service=off\nodeysys=on\n");
        assertThat(adapter.isOn("odeysys")).isTrue();
    }
}
