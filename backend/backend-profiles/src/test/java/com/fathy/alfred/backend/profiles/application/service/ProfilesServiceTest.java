package com.fathy.alfred.backend.profiles.application.service;

import com.fathy.alfred.backend.profiles.application.port.out.ProfileNotificationPort;
import com.fathy.alfred.backend.profiles.application.port.out.ProfileStorePort;
import com.fathy.alfred.backend.profiles.domain.model.NewProfile;
import com.fathy.alfred.backend.profiles.domain.model.Profile;
import com.fathy.alfred.backend.profiles.domain.model.ProfileUpdate;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ProfilesServiceTest {

    private final ProfileNotificationPort notificationPort = mock(ProfileNotificationPort.class);

    private static Profile profile(String id, String name, String avatar) {
        return new Profile(id, name, "2026-01-01T00:00:00Z", avatar);
    }

    @Test
    void assignsIdAndTimestampOnCreate() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        ProfilesService service = new ProfilesService(store, notificationPort);

        Profile created = service.create(new NewProfile("Ada", "🦊"));

        assertThat(created.id()).isNotBlank();
        assertThat(created.createdAt()).isNotBlank();
        assertThat(created.name()).isEqualTo("Ada");
        assertThat(created.avatar()).isEqualTo("🦊");

        ArgumentCaptor<Profile> captor = ArgumentCaptor.forClass(Profile.class);
        verify(store).save(captor.capture());
        assertThat(captor.getValue()).isEqualTo(created);
        verify(notificationPort).notifyProfilesChanged();
    }

    @Test
    void assignsARandomDefaultAvatarWhenNoneIsGiven() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        ProfilesService service = new ProfilesService(store, notificationPort);

        Profile created = service.create(new NewProfile("Ada", null));

        assertThat(created.avatar()).isNotBlank();

        Profile createdWithBlankAvatar = service.create(new NewProfile("Grace", "   "));

        assertThat(createdWithBlankAvatar.avatar()).isNotBlank();
    }

    @Test
    void listsAllProfiles() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.findAll()).thenReturn(List.of(profile("p1", "Ada", "🦊"), profile("p2", "Grace", "🐼")));
        ProfilesService service = new ProfilesService(store, notificationPort);

        assertThat(service.listAll()).extracting(Profile::id).containsExactly("p1", "p2");
    }

    @Test
    void getsByIdWhenPresent() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.findById("p1")).thenReturn(Optional.of(profile("p1", "Ada", "🦊")));
        ProfilesService service = new ProfilesService(store, notificationPort);

        assertThat(service.getById("p1")).isPresent();
        assertThat(service.getById("missing")).isEmpty();
    }

    @Test
    void updateMergesOnlyGivenFieldsOntoTheExisting() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        Profile existing = profile("p1", "Ada", "🦊");
        when(store.findById("p1")).thenReturn(Optional.of(existing));
        when(store.save(any())).thenAnswer(invocation -> invocation.getArgument(0));
        ProfilesService service = new ProfilesService(store, notificationPort);

        Optional<Profile> updated = service.update("p1", new ProfileUpdate(null, "🐼"));

        assertThat(updated).isPresent();
        assertThat(updated.get().name()).isEqualTo("Ada");
        assertThat(updated.get().avatar()).isEqualTo("🐼");
        assertThat(updated.get().id()).isEqualTo("p1");
        assertThat(updated.get().createdAt()).isEqualTo(existing.createdAt());
        verify(notificationPort).notifyProfilesChanged();
    }

    @Test
    void updateReturnsEmptyWhenTheIdDoesNotExist() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.findById("missing")).thenReturn(Optional.empty());
        ProfilesService service = new ProfilesService(store, notificationPort);

        assertThat(service.update("missing", new ProfileUpdate("New name", null))).isEmpty();
        verify(notificationPort, org.mockito.Mockito.never()).notifyProfilesChanged();
    }

    @Test
    void delegatesDeleteToTheStore() {
        ProfileStorePort store = mock(ProfileStorePort.class);
        when(store.deleteById(eq("p1"))).thenReturn(true);
        when(store.deleteById(eq("missing"))).thenReturn(false);
        ProfilesService service = new ProfilesService(store, notificationPort);

        assertThat(service.deleteById("p1")).isTrue();
        assertThat(service.deleteById("missing")).isFalse();
        verify(notificationPort, org.mockito.Mockito.times(1)).notifyProfilesChanged();
    }
}
