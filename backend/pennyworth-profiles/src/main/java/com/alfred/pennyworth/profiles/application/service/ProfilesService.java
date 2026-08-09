package com.alfred.pennyworth.profiles.application.service;

import com.alfred.pennyworth.profiles.application.port.in.CreateProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.DeleteProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.GetProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.in.ListProfilesUseCase;
import com.alfred.pennyworth.profiles.application.port.in.UpdateProfileUseCase;
import com.alfred.pennyworth.profiles.application.port.out.ProfileStorePort;
import com.alfred.pennyworth.profiles.domain.model.NewProfile;
import com.alfred.pennyworth.profiles.domain.model.Profile;
import com.alfred.pennyworth.profiles.domain.model.ProfileUpdate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

@Service
public class ProfilesService implements ListProfilesUseCase, GetProfileUseCase, CreateProfileUseCase, UpdateProfileUseCase, DeleteProfileUseCase {

    /**
     * Assigned when a profile is created without an explicit avatar, so new profiles are
     * visually distinguishable without forcing a choice. This is a small fallback palette for
     * direct API use (e.g. curl) - the real, 300+-entry emoji picker lives in the frontend
     * (core/models/avatar-emojis.ts); duplicating that whole list here would just be a second
     * copy to keep in sync for a path the UI itself never exercises, since manor always sends an
     * already-randomly-chosen avatar on create.
     */
    private static final List<String> DEFAULT_AVATAR_PALETTE = List.of(
            "🦊", "🐼", "🐸", "🦁", "🐙", "🦄", "🐢", "🦉", "🐳", "🐨", "🦋", "🐧", "🐝", "🦖", "🐬", "🦜"
    );

    private final ProfileStorePort store;

    public ProfilesService(ProfileStorePort store) {
        this.store = store;
    }

    @Override
    public List<Profile> listAll() {
        return store.findAll();
    }

    @Override
    public Optional<Profile> getById(String id) {
        return store.findById(id);
    }

    @Override
    public Profile create(NewProfile newProfile) {
        String id = UUID.randomUUID().toString();
        String avatar = newProfile.avatar() != null && !newProfile.avatar().isBlank()
                ? newProfile.avatar()
                : randomDefaultAvatar();
        Profile profile = new Profile(id, newProfile.name(), Instant.now().toString(), avatar);
        return store.save(profile);
    }

    @Override
    public Optional<Profile> update(String id, ProfileUpdate update) {
        return store.findById(id).map(existing -> {
            Profile updated = new Profile(
                    existing.id(),
                    update.name() != null ? update.name() : existing.name(),
                    existing.createdAt(),
                    update.avatar() != null ? update.avatar() : existing.avatar()
            );
            return store.save(updated);
        });
    }

    @Override
    public boolean deleteById(String id) {
        return store.deleteById(id);
    }

    /** A genuinely random pick each time, not derived from the id - two profiles created back to back can land on the same or different avatars either way. */
    private static String randomDefaultAvatar() {
        return DEFAULT_AVATAR_PALETTE.get(ThreadLocalRandom.current().nextInt(DEFAULT_AVATAR_PALETTE.size()));
    }
}
