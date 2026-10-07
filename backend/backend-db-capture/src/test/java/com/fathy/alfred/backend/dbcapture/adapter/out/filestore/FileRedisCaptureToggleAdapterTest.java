package com.fathy.alfred.backend.dbcapture.adapter.out.filestore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/** The ⬢ switch's flag file (specs/011-redis-capture T009) - same format as the ◆ and ▤ files, missing = off. */
class FileRedisCaptureToggleAdapterTest {

    @TempDir
    Path tempDir;

    @Test
    void aMissingFileOrLineMeansOff_andSwitchingKeepsOtherProjects() throws Exception {
        Path file = tempDir.resolve("redis-capture-enabled.flag");
        FileRedisCaptureToggleAdapter adapter = new FileRedisCaptureToggleAdapter();
        Field field = FileRedisCaptureToggleAdapter.class.getDeclaredField("toggleFile");
        field.setAccessible(true);
        field.set(adapter, file.toString());
        assertThat(adapter.isOn("odeysys")).isFalse();
        Files.writeString(file, "core-service=on\n");
        assertThat(adapter.isOn("odeysys")).isFalse();
        adapter.setOn("odeysys", true);
        assertThat(adapter.isOn("odeysys")).isTrue();
        assertThat(adapter.isOn("core-service")).isTrue();
    }
}
