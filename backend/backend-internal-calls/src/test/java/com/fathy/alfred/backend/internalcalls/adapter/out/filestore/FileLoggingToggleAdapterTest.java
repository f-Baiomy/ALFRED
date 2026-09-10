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

        assertThat(adapter.isEnabled("odeysys")).isTrue();
    }

    @Test
    void defaultsToEnabledWhenTheNameHasNoLineYet() throws IOException {
        Path file = tempDir.resolve("flag");
        Files.writeString(file, "core-service=off\n");

        assertThat(newAdapter(file).isEnabled("odeysys")).isTrue();
    }

    @Test
    void offIsCaseInsensitiveAndWhitespaceTolerantForItsOwnName() throws IOException {
        Path file = tempDir.resolve("flag");
        Files.writeString(file, "  odeysys = OFF  \n");

        assertThat(newAdapter(file).isEnabled("odeysys")).isFalse();
    }

    @Test
    void namesAreIndependent() throws IOException {
        Path file = tempDir.resolve("flag");
        Files.writeString(file, "odeysys=off\ncore-service=on\n");

        FileLoggingToggleAdapter adapter = newAdapter(file);
        assertThat(adapter.isEnabled("odeysys")).isFalse();
        assertThat(adapter.isEnabled("core-service")).isTrue();
    }

    @Test
    void setEnabledRoundTripsThroughIsEnabledWithoutAffectingOtherNames() {
        Path file = tempDir.resolve("flag");
        FileLoggingToggleAdapter adapter = newAdapter(file);
        adapter.setEnabled("core-service", true);

        adapter.setEnabled("odeysys", false);
        assertThat(adapter.isEnabled("odeysys")).isFalse();
        assertThat(adapter.isEnabled("core-service")).isTrue();

        adapter.setEnabled("odeysys", true);
        assertThat(adapter.isEnabled("odeysys")).isTrue();
    }

    @Test
    void setEnabledCreatesMissingParentDirectories() {
        Path file = tempDir.resolve("nested/dir/flag");
        FileLoggingToggleAdapter adapter = newAdapter(file);

        adapter.setEnabled("odeysys", false);

        assertThat(Files.exists(file)).isTrue();
        assertThat(adapter.isEnabled("odeysys")).isFalse();
    }
}
