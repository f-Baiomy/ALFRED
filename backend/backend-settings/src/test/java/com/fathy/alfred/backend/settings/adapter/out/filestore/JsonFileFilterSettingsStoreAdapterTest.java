package com.fathy.alfred.backend.settings.adapter.out.filestore;

import com.fathy.alfred.backend.settings.domain.model.CallFilterSettings;
import com.fathy.alfred.backend.settings.domain.model.FilterMode;
import com.fathy.alfred.backend.settings.domain.model.UrlRule;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileFilterSettingsStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileFilterSettingsStoreAdapter adapterFor(Path filterSettingsFile) throws Exception {
        JsonFileFilterSettingsStoreAdapter adapter = new JsonFileFilterSettingsStoreAdapter();
        Field field = JsonFileFilterSettingsStoreAdapter.class.getDeclaredField("filterSettingsFile");
        field.setAccessible(true);
        field.set(adapter, filterSettingsFile.toString());
        return adapter;
    }

    @Test
    void loadReturnsDefaultsWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileFilterSettingsStoreAdapter adapter = adapterFor(tempDir.resolve("filter-settings.json"));

        CallFilterSettings settings = adapter.load();

        assertThat(settings).isEqualTo(CallFilterSettings.defaults());
    }

    @Test
    void saveThenLoadRoundTrips() throws Exception {
        JsonFileFilterSettingsStoreAdapter adapter = adapterFor(tempDir.resolve("filter-settings.json"));
        CallFilterSettings settings = new CallFilterSettings(
                FilterMode.ACCEPT_ONLY,
                List.of(new UrlRule("r1", "allowed.com", true)),
                List.of(new UrlRule("b1", "blocked.com", true)));

        adapter.save(settings);

        assertThat(adapter.load()).isEqualTo(settings);
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("filter-settings.json");
        CallFilterSettings settings = new CallFilterSettings(
                FilterMode.ACCEPT_ONLY, List.of(new UrlRule("r1", "allowed.com", false)), List.of());
        adapterFor(file).save(settings);

        JsonFileFilterSettingsStoreAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.load()).isEqualTo(settings);
    }

    @Test
    void createsMissingParentDirectoriesOnStartupCheck() throws Exception {
        Path nested = tempDir.resolve("nested/dir/filter-settings.json");
        JsonFileFilterSettingsStoreAdapter adapter = adapterFor(nested);

        adapter.checkStorageIsWritable();

        assertThat(nested.getParent()).exists();
        assertThat(adapter.load()).isEqualTo(CallFilterSettings.defaults());
    }
}
