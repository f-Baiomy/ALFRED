package com.fathy.alfred.backend.profiles.adapter.out.profilestore;

import com.fathy.alfred.backend.profiles.domain.model.Profile;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class JsonFileProfileStoreAdapterTest {

    @TempDir
    Path tempDir;

    private JsonFileProfileStoreAdapter adapterFor(Path profilesFile) throws Exception {
        JsonFileProfileStoreAdapter adapter = new JsonFileProfileStoreAdapter();
        Field field = JsonFileProfileStoreAdapter.class.getDeclaredField("profilesFile");
        field.setAccessible(true);
        field.set(adapter, profilesFile.toString());
        return adapter;
    }

    private static Profile profile(String id) {
        return new Profile(id, "Ada", "2026-01-01T00:00:00Z", "🦊");
    }

    @Test
    void findAllReturnsEmptyWhenTheFileDoesNotExistYet() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));

        assertThat(adapter.findAll()).isEmpty();
    }

    @Test
    void saveThenFindAllRoundTrips() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));

        adapter.save(profile("p1"));
        adapter.save(profile("p2"));

        assertThat(adapter.findAll()).extracting(Profile::id).containsExactlyInAnyOrder("p1", "p2");
    }

    @Test
    void saveOverwritesAnExistingProfileWithTheSameId() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));
        adapter.save(profile("p1"));

        adapter.save(new Profile("p1", "Ada Lovelace", "2026-01-01T00:00:00Z", "🐼"));

        List<Profile> all = adapter.findAll();
        assertThat(all).hasSize(1);
        assertThat(all.get(0).name()).isEqualTo("Ada Lovelace");
        assertThat(all.get(0).avatar()).isEqualTo("🐼");
    }

    @Test
    void findByIdReturnsTheMatchingProfile() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));
        adapter.save(profile("p1"));
        adapter.save(profile("p2"));

        Optional<Profile> found = adapter.findById("p2");

        assertThat(found).isPresent();
        assertThat(found.get().id()).isEqualTo("p2");
        assertThat(adapter.findById("missing")).isEmpty();
    }

    @Test
    void persistsAcrossAFreshAdapterInstancePointedAtTheSameFile() throws Exception {
        Path file = tempDir.resolve("profiles.json");
        adapterFor(file).save(profile("p1"));

        JsonFileProfileStoreAdapter secondInstance = adapterFor(file);

        assertThat(secondInstance.findAll()).extracting(Profile::id).containsExactly("p1");
    }

    @Test
    void deleteByIdRemovesOnlyTheMatchingProfile() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));
        adapter.save(profile("p1"));
        adapter.save(profile("p2"));

        boolean removed = adapter.deleteById("p1");

        assertThat(removed).isTrue();
        assertThat(adapter.findAll()).extracting(Profile::id).containsExactly("p2");
    }

    @Test
    void deleteByIdReturnsFalseWhenTheIdDoesNotExist() throws Exception {
        JsonFileProfileStoreAdapter adapter = adapterFor(tempDir.resolve("profiles.json"));
        adapter.save(profile("p1"));

        assertThat(adapter.deleteById("missing")).isFalse();
        assertThat(adapter.findAll()).hasSize(1);
    }

    @Test
    void createsMissingParentDirectoriesOnStartupCheck() throws Exception {
        Path nested = tempDir.resolve("nested/dir/profiles.json");
        JsonFileProfileStoreAdapter adapter = adapterFor(nested);

        adapter.checkStorageIsWritable();

        assertThat(nested.getParent()).exists();
        assertThat(adapter.findAll()).isEmpty();
    }
}
