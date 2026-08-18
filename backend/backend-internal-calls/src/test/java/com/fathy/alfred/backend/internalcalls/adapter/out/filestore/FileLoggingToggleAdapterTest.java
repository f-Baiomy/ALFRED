package com.fathy.alfred.backend.internalcalls.adapter.out.filestore;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class FileLoggingToggleAdapterTest {

    @TempDir
    Path tempDir;

    private FileLoggingToggleAdapter newAdapter(Path file) {
        FileLoggingToggleAdapter adapter = new FileLoggingToggleAdapter();
        try {
            Field field = FileLoggingToggleAdapter.class.getDeclaredField("toggleFile");
            field.setAccessible(true);
            field.set(adapter, file.toString());
        } catch (ReflectiveOperationException e) {
            throw new RuntimeException(e);
        }
        return adapter;
    }

    @Test
    void defaultsToEnabledWhenTheFileDoesNotExist() {
        FileLoggingToggleAdapter adapter = newAdapter(tempDir.resolve("missing.flag"));

        assertThat(adapter.isEnabled()).isTrue();
    }

    @Test
    void offIsCaseInsensitiveAndWhitespaceTolerant() throws IOException {
        Path file = tempDir.resolve("flag");
        Files.writeString(file, "  OFF  \n");

        assertThat(newAdapter(file).isEnabled()).isFalse();
    }

    @Test
    void anyContentOtherThanOffCountsAsEnabled() throws IOException {
        Path file = tempDir.resolve("flag");
        Files.writeString(file, "on\n");

        assertThat(newAdapter(file).isEnabled()).isTrue();
    }

    @Test
    void setEnabledRoundTripsThroughIsEnabled() {
        FileLoggingToggleAdapter adapter = newAdapter(tempDir.resolve("flag"));

        adapter.setEnabled(false);
        assertThat(adapter.isEnabled()).isFalse();

        adapter.setEnabled(true);
        assertThat(adapter.isEnabled()).isTrue();
    }

    @Test
    void setEnabledCreatesMissingParentDirectories() {
        Path file = tempDir.resolve("nested/dir/flag");
        FileLoggingToggleAdapter adapter = newAdapter(file);

        adapter.setEnabled(false);

        assertThat(Files.exists(file)).isTrue();
        assertThat(adapter.isEnabled()).isFalse();
    }
}
